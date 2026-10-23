import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';

type Result={status:number;body:Record<string,any>};
type Account=ReturnType<typeof privateKeyToAccount>;

async function freePort(excluded:Set<number>):Promise<number> {
  while(true) {
    const server=createServer();
    const port=await new Promise<number>((resolve,reject)=>{
      server.once('error',reject);
      server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port));
    });
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(!excluded.has(port)){excluded.add(port);return port;}
  }
}

function startServer(port:number,databasePath:string) {
  const child=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{
    cwd:process.cwd(),env:{...process.env,P2P_DB_PATH:databasePath,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],
  });
  let output='';
  const collect=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-4000);};
  child.stdout.on('data',collect);
  child.stderr.on('data',collect);
  return {child,base:`http://127.0.0.1:${port}`,logs:()=>output};
}

async function ready(base:string,child:ReturnType<typeof startServer>['child']) {
  const deadline=Date.now()+20_000;
  while(Date.now()<deadline) {
    if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Server exited with code ${child.exitCode}, signal ${child.signalCode}`);
    try {const response=await fetch(`${base}/api/v1/ads`,{signal:AbortSignal.timeout(1000)});if(response.ok)return;} catch {}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`Server did not start: ${base}`);
}

async function stop(child:ReturnType<typeof startServer>['child']) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGTERM');
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(resolve,5000);})]);
  clearTimeout(timer);
  if(child.exitCode===null){child.kill('SIGKILL');await exited;}
}

async function post(base:string,path:string,body:unknown,cookie?:string,key?:string):Promise<Result> {
  const response=await fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(key?{'Idempotency-Key':key}:{})},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
}

async function get(base:string,path:string,cookie:string):Promise<Record<string,any>> {
  const response=await fetch(base+path,{headers:{Cookie:cookie}});
  assert.equal(response.status,200,`${path}: ${response.status}`);
  return response.json();
}

async function login(base:string,account:Account):Promise<string> {
  const challenge=await post(base,'/api/v1/auth/challenge',{address:account.address,chainId:11155111});
  assert.equal(challenge.status,200,JSON.stringify(challenge.body));
  const message=challenge.body.message as string;
  const signature=await account.signMessage({message});
  const response=await fetch(base+'/api/v1/auth/verify',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({message,signature})});
  assert.equal(response.status,200,await response.text());
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  if(!cookie?.startsWith('peer_session='))throw new Error('SIWE session cookie was not set.');
  return cookie;
}

async function main() {
  const directory=mkdtempSync(join(tmpdir(),'p2p-concurrency-'));
  const databasePath=join(directory,'p2p.sqlite');
  const ports=new Set<number>();
  const servers=[] as ReturnType<typeof startServer>[];
  try {
    const first=startServer(await freePort(ports),databasePath);servers.push(first);await ready(first.base,first.child);
    const second=startServer(await freePort(ports),databasePath);servers.push(second);await ready(second.base,second.child);
    const maker=privateKeyToAccount(generatePrivateKey());
    const makerCookie=await login(first.base,maker);
    const takers=await Promise.all(Array.from({length:4},async(_,index)=>{
      const server=servers[index%2];
      return {server,cookie:await login(server.base,privateKeyToAccount(generatePrivateKey()))};
    }));
    let accepted=0;
    for(const capacity of [1,2])for(let round=0;round<8;round++) {
      const adResponse=await post(first.base,'/api/v1/ads',{side:'buy',asset:'ETH',price:'2000',total:capacity===1?'0.05':'0.1',min:'100',max:'100',minutes:15,validHours:24},makerCookie);
      assert.equal(adResponse.status,201,JSON.stringify(adResponse.body));
      const adId=adResponse.body.ad.id as string;
      const attempts=takers.map((taker,index)=>({taker,key:`concurrency-${round}-${capacity}-${index}-${crypto.randomUUID()}`}));
      const results=await Promise.all(attempts.map(({taker,key})=>post(taker.server.base,'/api/v1/orders',{adId,amount:'100'},taker.cookie,key)));
      const winners=results.map((result,index)=>({result,index})).filter(item=>item.result.status===201);
      assert.equal(winners.length,capacity,JSON.stringify({capacity,round,results}));
      assert.ok(results.every(result=>result.status===201||result.status===400||result.status===409),JSON.stringify({capacity,round,results}));
      for(const server of servers) {
        const ad=(await get(server.base,'/api/v1/me/ads',makerCookie)).ads.find((item:{id:string})=>item.id===adId);
        assert.equal(ad.available,'0');
        assert.equal(ad.version,capacity+1);
        const orders=(await get(server.base,'/api/v1/me/incoming-orders',makerCookie)).orders.filter((item:{ad_id:string})=>item.ad_id===adId);
        assert.equal(orders.length,capacity);
        assert.equal(new Set(orders.map((item:{id:string})=>item.id)).size,capacity);
        assert.equal(orders.reduce((sum:bigint,item:{asset_amount:string})=>sum+BigInt(item.asset_amount),0n),BigInt(capacity)*50_000_000_000_000_000n);
      }
      const winner=winners[0];
      const retry=await post(servers[1-winner.index%2].base,'/api/v1/orders',{adId,amount:'100'},attempts[winner.index].taker.cookie,attempts[winner.index].key);
      assert.equal(retry.status,201,JSON.stringify(retry.body));
      assert.equal(retry.body.order.id,winner.result.body.order.id);
      accepted+=winners.length;
    }
    console.log(`PASS: two server processes, 16 rounds, 64 simultaneous reservation requests, ${accepted} accepted within capacity, cross-server idempotency preserved.`);
  } catch(error) {
    for(const server of servers)console.error(`${server.base} logs:\n${server.logs()}`);
    throw error;
  } finally {
    await Promise.all(servers.map(server=>stop(server.child)));
    rmSync(directory,{recursive:true,force:true});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
