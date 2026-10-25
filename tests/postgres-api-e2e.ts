import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { closePostgres, query } from '../lib/postgres';
import { cancelOrder, createAd, createSession, reserveOrder } from '../lib/store-pg';

const name=`p2p-pg-api-${process.pid}-${randomBytes(3).toString('hex')}`;
const migration=readFileSync(resolve('supabase/migrations/20261023000100_initial_p2p.sql'),'utf8');
const password='local-test-only';
const children:ChildProcess[]=[];
let started=false;

function docker(args:string[],input?:string) {
  const result=spawnSync('docker',args,{encoding:'utf8',input,maxBuffer:1024*1024});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`Docker 명령 실패: ${result.stderr||result.stdout}`);
  return result.stdout.trim();
}
async function freePort() {
  const server=createServer();
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const port=(server.address() as {port:number}).port;
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  return port;
}
async function until(check:()=>Promise<boolean>,description:string,logs:()=>string=()=>'',deadlineMs=20_000) {
  const deadline=Date.now()+deadlineMs;
  while(Date.now()<deadline) {
    try {if(await check()) return;} catch { /* Starting. */ }
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw new Error(`${description} 대기 시간 초과: ${logs()}`);
}
function start(binary:string,args:string[],env:NodeJS.ProcessEnv) {
  const child=spawn(binary,args,{cwd:process.cwd(),env,stdio:['ignore','pipe','pipe']});
  children.push(child);
  let output='';
  const collect=(chunk:Buffer)=>{output=(output+chunk.toString()).slice(-5000);};
  child.stdout?.on('data',collect);
  child.stderr?.on('data',collect);
  return {child,logs:()=>output};
}
async function stop(child:ChildProcess) {
  if(child.exitCode!==null||child.signalCode!==null) return;
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGTERM');
  await Promise.race([exited,new Promise(resolve=>setTimeout(resolve,5000))]);
  if(child.exitCode===null&&child.signalCode===null) {child.kill('SIGKILL');await exited;}
}
async function main() {
  try {
    docker(['run','--rm','-d','--name',name,'-e',`POSTGRES_PASSWORD=${password}`,'-e','POSTGRES_DB=p2p','-p','127.0.0.1::5432','postgres:17-alpine']);
    started=true;
    await until(async()=>{
      const logs=spawnSync('docker',['logs',name],{encoding:'utf8'});
      const probe=spawnSync('docker',['exec',name,'psql','-X','-U','postgres','-d','p2p','-At','-c','SELECT 1'],{encoding:'utf8'});
      return (logs.stdout+logs.stderr).includes('PostgreSQL init process complete')&&probe.status===0;
    },'PostgreSQL 시작');
    docker(['exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','p2p'],migration);
    const address=docker(['port',name,'5432/tcp']).split('\n')[0];
    const port=Number(address.slice(address.lastIndexOf(':')+1));
    assert.ok(Number.isInteger(port)&&port>0);
    process.env.DATABASE_URL=`postgres://postgres:${password}@127.0.0.1:${port}/p2p`;
    process.env.P2P_PG_POOL_MAX='10';
    await query("INSERT INTO p2p.ads (id,maker,initials,side,asset,price,available_units,total_units,min,max,minutes) VALUES ('eth-01','Seoul Node','SN','buy','ETH','2645.5','12500000000000000000','12500000000000000000','100','10000',15)");

    const terms={side:'buy',asset:'ETH',price:'2000',total:'1',min:'100',max:'2000',minutes:15,validHours:24};
    const contested=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const attempts=await Promise.allSettled(Array.from({length:16},(_,index)=>reserveOrder(`0x${(index+1).toString(16).padStart(40,'0')}`,contested.id,'2000',`pg-race-${index}-${randomUUID()}`)));
    assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
    assert.equal(attempts.filter(result=>result.status==='rejected'&&result.reason?.status===409).length,15);
    const stock=await query<{available_units:string;version:number}>('SELECT available_units,version FROM p2p.ads WHERE id=$1',[contested.id]);
    assert.equal(stock.rows[0].available_units,'0');
    assert.equal(stock.rows[0].version,2);

    const idempotent=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const same=await Promise.all(Array.from({length:8},()=>reserveOrder('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',idempotent.id,'100','same-pg-request-123456')));
    assert.equal(new Set(same.map(order=>order.id)).size,1);
    const count=await query<{count:string}>('SELECT count(*) AS count FROM p2p.orders WHERE ad_id=$1',[idempotent.id]);
    assert.equal(Number(count.rows[0].count),1);

    const expiry=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const expiring=await reserveOrder('0xcccccccccccccccccccccccccccccccccccccccc',expiry.id,'100','pg-expiry-key-123456');
    await query('UPDATE p2p.orders SET response_due_at=$1 WHERE id=$2',[Date.now()-1000,expiring.id]);
    const workerEnv={...process.env,P2P_EXPIRY_INTERVAL_MS:'200'};
    const worker=start(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/expire-reservations-worker.ts'],workerEnv);
    const secondWorker=start(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/expire-reservations-worker.ts'],workerEnv);
    await until(async()=>{
      const result=await query<{state:string}>('SELECT state FROM p2p.orders WHERE id=$1',[expiring.id]);
      return result.rows[0]?.state==='EXPIRED';
    },'PostgreSQL 예약 만료',worker.logs);
    const restored=await query<{available_units:string}>('SELECT available_units FROM p2p.ads WHERE id=$1',[expiry.id]);
    assert.equal(restored.rows[0].available_units,'1000000000000000000');
    await new Promise(resolve=>setTimeout(resolve,450));
    const expiryEvents=await query<{count:string}>("SELECT count(*) AS count FROM p2p.order_events WHERE order_id=$1 AND state='EXPIRED'",[expiring.id]);
    assert.equal(Number(expiryEvents.rows[0].count),1);
    await Promise.all([stop(worker.child),stop(secondWorker.child)]);

    const retained=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const retainedOrder=await reserveOrder('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',retained.id,'100','pg-retention-key-123456');
    await cancelOrder('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',retainedOrder.id);
    const endedAt=Date.now()-181*24*60*60_000;
    await query("UPDATE p2p.order_events SET occurred_at=$1 WHERE order_id=$2 AND state='CANCELLED'",[endedAt,retainedOrder.id]);
    await query('INSERT INTO p2p.order_messages (order_id,sender,client_id,body,created_at) VALUES ($1,$2,$3,$4,$5)',[retainedOrder.id,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',randomUUID(),'old message',endedAt]);
    await query('INSERT INTO p2p.order_reports (id,order_id,reporter,reported,reason,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),retainedOrder.id,'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','OTHER','old report details',endedAt]);
    const prune=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/prune-sensitive-data.ts'],{cwd:process.cwd(),env:process.env,encoding:'utf8',timeout:20_000});
    assert.equal(prune.status,0,prune.stderr);
    assert.match(prune.stdout,/삭제 완료: 대화 1건, 신고 1건/);

    const webPort=await freePort();
    const base=`http://127.0.0.1:${webPort}`;
    const cronSecret='local-cron-test-secret';
    const web=start(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(webPort)],{...process.env,NEXT_TELEMETRY_DISABLED:'1',CRON_SECRET:cronSecret,P2P_ADMIN_ADDRESSES:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'});
    await until(async()=>{const response=await fetch(base+'/api/health');return response.status===200;},'Next.js 웹 서버',web.logs);

    const cronAd=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const cronOrder=await reserveOrder('0xffffffffffffffffffffffffffffffffffffffff',cronAd.id,'100','pg-cron-expiry-key-123456');
    await query('UPDATE p2p.orders SET response_due_at=$1 WHERE id=$2',[Date.now()-1000,cronOrder.id]);
    for(const authorization of [undefined,'Bearer invalid']) {
      const denied=await fetch(base+'/api/cron/expire',{headers:authorization?{Authorization:authorization}:undefined});
      assert.equal(denied.status,401);
    }
    assert.equal((await query<{state:string}>('SELECT state FROM p2p.orders WHERE id=$1',[cronOrder.id])).rows[0].state,'RESERVED');
    const cronHeaders={Authorization:`Bearer ${cronSecret}`};
    const expiredByCron=await fetch(base+'/api/cron/expire',{headers:cronHeaders});
    assert.equal(expiredByCron.status,200,await expiredByCron.text());
    assert.equal((await query<{state:string}>('SELECT state FROM p2p.orders WHERE id=$1',[cronOrder.id])).rows[0].state,'EXPIRED');
    assert.equal((await query<{available_units:string}>('SELECT available_units FROM p2p.ads WHERE id=$1',[cronAd.id])).rows[0].available_units,'1000000000000000000');
    assert.equal((await query<{count:number}>("SELECT count(*) AS count FROM p2p.order_events WHERE order_id=$1 AND state='EXPIRED'",[cronOrder.id])).rows[0].count,1);

    const cronRetained=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const cronRetainedOrder=await reserveOrder('0xffffffffffffffffffffffffffffffffffffffff',cronRetained.id,'100','pg-cron-retention-key-123456');
    await cancelOrder('0xffffffffffffffffffffffffffffffffffffffff',cronRetainedOrder.id);
    await query("UPDATE p2p.order_events SET occurred_at=$1 WHERE order_id=$2 AND state='CANCELLED'",[endedAt,cronRetainedOrder.id]);
    await query('INSERT INTO p2p.order_messages (order_id,sender,client_id,body,created_at) VALUES ($1,$2,$3,$4,$5)',[cronRetainedOrder.id,'0xffffffffffffffffffffffffffffffffffffffff',randomUUID(),'old message',endedAt]);
    await query('INSERT INTO p2p.order_reports (id,order_id,reporter,reported,reason,details,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),cronRetainedOrder.id,'0xffffffffffffffffffffffffffffffffffffffff','0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','OTHER','old report details',endedAt]);
    assert.equal((await fetch(base+'/api/cron/retention')).status,401);
    const prunedByCron=await fetch(base+'/api/cron/retention',{headers:cronHeaders});
    assert.equal(prunedByCron.status,200);
    assert.deepEqual((await prunedByCron.json()).removed,{messages:1,reports:1});
    assert.equal((await query<{count:number}>('SELECT count(*) AS count FROM p2p.order_messages WHERE order_id=$1',[cronRetainedOrder.id])).rows[0].count,0);
    assert.equal((await query<{count:number}>('SELECT count(*) AS count FROM p2p.order_reports WHERE order_id=$1',[cronRetainedOrder.id])).rows[0].count,0);

    const smokeEnv={...process.env,P2P_TEST_BASE_URL:base};
    for(const script of ['tests/admin-api-smoke.ts','tests/api-smoke.ts']) {
      const result=spawnSync(process.execPath,['node_modules/tsx/dist/cli.mjs',script],{cwd:process.cwd(),env:smokeEnv,encoding:'utf8',timeout:60_000});
      assert.equal(result.status,0,`${script}: ${result.stderr}\n${result.stdout}\n${web.logs()}`);
    }
    const secondPort=await freePort();
    const secondBase=`http://127.0.0.1:${secondPort}`;
    const secondWeb=start(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(secondPort)],{...process.env,NEXT_TELEMETRY_DISABLED:'1',P2P_ADMIN_ADDRESSES:'0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf'});
    await until(async()=>{const response=await fetch(secondBase+'/api/health');return response.status===200;},'두 번째 웹 서버',secondWeb.logs);
    const sharedAddress='0xdddddddddddddddddddddddddddddddddddddddd';
    const sharedCookie=`peer_session=${await createSession(sharedAddress)}`;
    assert.equal((await (await fetch(secondBase+'/api/v1/auth/me',{headers:{Cookie:sharedCookie}})).json()).address,sharedAddress);
    const sharedAd=await createAd('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',terms);
    const request=(target:string,key:string)=>fetch(target+'/api/v1/orders',{method:'POST',headers:{Origin:target,'Content-Type':'application/json',Cookie:sharedCookie,'Idempotency-Key':key},body:JSON.stringify({adId:sharedAd.id,amount:'2000'})});
    const responses=await Promise.all(Array.from({length:16},(_,index)=>request(index%2?base:secondBase,`cross-web-${index}-${randomUUID()}`)));
    assert.equal(responses.filter(response=>response.status===201).length,1);
    assert.equal(responses.filter(response=>response.status===409).length,15);
    const sharedStock=await query<{available_units:string}>('SELECT available_units FROM p2p.ads WHERE id=$1',[sharedAd.id]);
    assert.equal(sharedStock.rows[0].available_units,'0');
    const chain=await fetch(base+'/api/v1/chain/config');
    assert.equal((await chain.json()).enabled,false);
    console.log('PASS: PostgreSQL API, 16-way stock race across two web servers, shared SIWE session, same-key idempotency, expiry worker, conversation, reports, admin review.');
  } finally {
    await Promise.all(children.map(stop));
    await closePostgres();
    if(started) spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
