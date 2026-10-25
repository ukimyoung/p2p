import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

const databasePath=process.env.P2P_DB_PATH;
if(process.env.DATABASE_URL) throw new Error('PostgreSQL 배포에서는 예약 만료 작업을 배포 환경의 스케줄러로 별도 실행하세요.');
if(!databasePath||!existsSync(databasePath)) throw new Error('기존 SQLite DB 경로를 P2P_DB_PATH로 지정하세요.');
const required=['P2P_CHAIN_RPC_URL','P2P_CHAIN_ID','P2P_ESCROW_ADDRESS','P2P_USDC_ADDRESS','P2P_WETH_ADDRESS','P2P_CHAIN_START_BLOCK'];
if(required.some(key=>!process.env[key])) throw new Error('로컬 체인 설정이 완전하지 않습니다.');
const intervals={
  reservations:Number(process.env.P2P_EXPIRY_INTERVAL_MS??30_000),
  chain:Number(process.env.P2P_CHAIN_SYNC_INTERVAL_MS??5_000),
};
if(Object.values(intervals).some(value=>!Number.isSafeInteger(value)||value<100)) throw new Error('작업 간격은 100ms 이상인 정수여야 합니다.');

const statusPath=`${databasePath}.workers.json`;
const lockPath=`${statusPath}.lock`;
function alive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0) return false;
  try {process.kill(pid,0);return true;} catch(error) {return error?.code==='EPERM';}
}
function acquireLock() {
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const fd=openSync(lockPath,'wx',0o600);
      try {writeFileSync(fd,String(process.pid));} finally {closeSync(fd);}
      return;
    } catch(error) {
      if(error?.code!=='EEXIST') throw error;
      let previous;
      try {previous=Number(readFileSync(lockPath,'utf8'));}
      catch(readError) {if(readError?.code==='ENOENT') continue;throw readError;}
      if(alive(previous)) throw new Error(`작업 감독 프로세스가 이미 실행 중입니다 (PID ${previous}).`);
      if(!previous&&Date.now()-statSync(lockPath).mtimeMs<5000) throw new Error('작업 감독 잠금이 생성 중입니다. 잠시 후 다시 시도하세요.');
      try {unlinkSync(lockPath);} catch(removeError) {if(removeError?.code!=='ENOENT') throw removeError;}
    }
  }
  throw new Error('작업 감독 잠금을 확보하지 못했습니다.');
}
acquireLock();

const startedAt=Date.now();
const status={
  version:1,supervisorPid:process.pid,startedAt,updatedAt:startedAt,
  workers:Object.fromEntries(Object.entries(intervals).map(([name,intervalMs])=>[name,{
    pid:null,state:'starting',intervalMs,lastRunAt:null,lastSuccessAt:null,lastErrorAt:null,lastError:null,restarts:0,nextRestartAt:null,
  }])),
};
const children=new Map();
const restartTimers=new Map();
let stopping=false;

function publish() {
  status.updatedAt=Date.now();
  const temporary=`${statusPath}.${process.pid}.tmp`;
  writeFileSync(temporary,JSON.stringify(status,null,2),{mode:0o600});
  renameSync(temporary,statusPath);
}

const args={
  reservations:['--import','tsx','scripts/expire-reservations-worker.ts'],
  chain:['--import','tsx','--conditions=react-server','scripts/sync-chain-worker.ts'],
};
function start(name) {
  const state=status.workers[name];
  const child=spawn(process.execPath,args[name],{cwd:process.cwd(),env:process.env,stdio:['ignore','inherit','inherit','ipc']});
  children.set(name,child);
  state.pid=child.pid??null;
  state.state='starting';
  state.lastRunAt=null;
  state.lastSuccessAt=null;
  state.lastError=null;
  state.nextRestartAt=null;
  publish();
  child.on('message',message=>{
    if(!message||message.kind!=='p2p-worker-sweep'||typeof message.ok!=='boolean') return;
    state.lastRunAt=Date.now();
    if(message.ok) {state.state='ok';state.lastSuccessAt=state.lastRunAt;state.lastError=null;}
    else {state.state='error';state.lastErrorAt=state.lastRunAt;state.lastError=String(message.error??'작업 실패').slice(0,200);}
    publish();
  });
  child.on('error',error=>{console.error(`${name} 작업 시작 실패:`,error);});
  child.on('close',(code,signal)=>{
    children.delete(name);
    state.pid=null;
    if(stopping) return;
    state.state='restarting';
    state.lastErrorAt=Date.now();
    state.lastError=`프로세스 종료: ${signal??code}`;
    state.restarts++;
    const delay=Math.min(1000*2**Math.min(state.restarts-1,5),30_000);
    state.nextRestartAt=Date.now()+delay;
    publish();
    console.error(`${name} 작업 종료 (${signal??code}); ${delay}ms 후 재시작합니다.`);
    restartTimers.set(name,setTimeout(()=>{restartTimers.delete(name);start(name);},delay));
  });
}

async function shutdown() {
  if(stopping) return;
  stopping=true;
  for(const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  await Promise.all([...children.values()].map(child=>new Promise(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null) return resolve();
    const timeout=setTimeout(()=>child.kill('SIGKILL'),5000);
    child.once('close',()=>{clearTimeout(timeout);resolve();});
    child.kill('SIGTERM');
  })));
  for(const state of Object.values(status.workers)) {state.pid=null;state.state='stopped';state.nextRestartAt=null;}
  publish();
  unlinkSync(lockPath);
}
process.once('SIGINT',()=>void shutdown());
process.once('SIGTERM',()=>void shutdown());

publish();
start('reservations');
start('chain');
console.log(`작업 감독 시작 (PID ${process.pid}); 상태: ${statusPath}`);
