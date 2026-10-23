import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../lib/store';

const directory=mkdtempSync(join(tmpdir(),'p2p-expiry-worker-'));
const databasePath=join(directory,'p2p.sqlite');
const maker='0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const taker='0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const terms={side:'buy',asset:'ETH',price:'2000',total:'1',min:'100',max:'1500',minutes:15,validHours:24};
const workers:ReturnType<typeof spawn>[]=[];

function startWorker() {
  const child=spawn(process.execPath,['node_modules/tsx/dist/cli.mjs','scripts/expire-reservations-worker.ts'],{
    cwd:process.cwd(),env:{...process.env,P2P_DB_PATH:databasePath,P2P_EXPIRY_INTERVAL_MS:'200'},stdio:['ignore','pipe','pipe'],
  });
  workers.push(child);
  let output='';
  child.stdout.on('data',chunk=>{output+=chunk.toString();});
  child.stderr.on('data',chunk=>{output+=chunk.toString();});
  return {child,logs:()=>output};
}

async function until(check:()=>boolean,description:string,logs:()=>string) {
  const deadline=Date.now()+10_000;
  while(Date.now()<deadline) {
    if(check()) return;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error(`${description}: ${logs()}`);
}

async function stopWorker(child:ReturnType<typeof spawn>) {
  if(child.exitCode!==null||child.signalCode!==null) return;
  const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
  child.kill('SIGTERM');
  let timeout:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([exited,new Promise(resolve=>{timeout=setTimeout(resolve,5000);})]);
  clearTimeout(timeout);
  if(child.exitCode===null&&child.signalCode===null) {child.kill('SIGKILL');await exited;}
}

async function main() {
  try {
    process.env.P2P_DB_PATH=databasePath;
    const ad=store.createAd(maker,terms);
    const reserved=store.reserveOrder(taker,ad.id,'500','worker-reserved-order-key');
    const accepted=store.reserveOrder(taker,ad.id,'500','worker-accepted-order-key');
    const reservedId=String(reserved.id);
    const acceptedId=String(accepted.id);
    store.respondOrder(maker,acceptedId,'accept');
    const expiringAd=store.createAd(maker,terms);
    const database=store.db();
    const before=database.prepare('SELECT available_units,version FROM ads WHERE id=?').get(ad.id) as {available_units:string;version:number};
    assert.equal(before.available_units,'500000000000000000');

    const first=startWorker();
    const second=startWorker();
    for(const worker of [first,second]) {
      await until(()=>worker.logs().includes('예약 만료 작업 시작'),'작업 프로세스 시작',worker.logs);
      assert.equal(worker.child.exitCode,null,worker.logs());
    }
    assert.equal((database.prepare('SELECT state FROM orders WHERE id=?').get(reservedId) as {state:string}).state,'RESERVED');
    assert.equal((database.prepare('SELECT state FROM orders WHERE id=?').get(acceptedId) as {state:string}).state,'ACCEPTED');

    const past=Date.now()-1;
    database.prepare('UPDATE orders SET response_due_at=? WHERE id=?').run(past,reservedId);
    database.prepare('UPDATE orders SET expires_at=? WHERE id=?').run(past,acceptedId);
    database.prepare('UPDATE ads SET expires_at=? WHERE id=?').run(past,expiringAd.id);

    await until(()=>{
      const states=database.prepare('SELECT state FROM orders WHERE id IN (?,?) ORDER BY id').all(reservedId,acceptedId) as {state:string}[];
      const adRow=database.prepare('SELECT available_units,version FROM ads WHERE id=?').get(ad.id) as {available_units:string;version:number};
      const other=database.prepare('SELECT status FROM ads WHERE id=?').get(expiringAd.id) as {status:string};
      return states.every(row=>row.state==='EXPIRED')&&adRow.available_units==='1000000000000000000'&&other.status==='EXPIRED';
    },'조회 없이 예약·광고 만료',()=>first.logs()+second.logs());

    const after=database.prepare('SELECT available_units,version FROM ads WHERE id=?').get(ad.id) as {available_units:string;version:number};
    assert.equal(after.version,before.version+2);
    for(const id of [reservedId,acceptedId]) {
      const events=database.prepare('SELECT state,actor FROM order_events WHERE order_id=? ORDER BY id').all(id) as {state:string;actor:string}[];
      assert.equal(events.filter(event=>event.state==='EXPIRED'&&event.actor==='system').length,1);
    }
    const expiredAd=database.prepare('SELECT version FROM ads WHERE id=?').get(expiringAd.id) as {version:number};
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(database.prepare('SELECT available_units,version FROM ads WHERE id=?').get(ad.id),after);
    assert.deepEqual(database.prepare('SELECT version FROM ads WHERE id=?').get(expiringAd.id),expiredAd);
    for(const id of [reservedId,acceptedId]) {
      assert.equal((database.prepare("SELECT COUNT(*) AS count FROM order_events WHERE order_id=? AND state='EXPIRED'").get(id) as {count:number}).count,1);
    }
    console.log('PASS: two independent workers expire reserved and accepted orders and ads without HTTP reads; inventory and history change once.');
  } finally {
    await Promise.all(workers.map(stopWorker));
    store.resetStoreForTests();
    rmSync(directory,{recursive:true,force:true});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
