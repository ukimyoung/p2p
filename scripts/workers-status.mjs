import { readFileSync } from 'node:fs';

const databasePath=process.env.P2P_DB_PATH;
if(!databasePath) throw new Error('P2P_DB_PATH를 지정하세요.');
const path=`${databasePath}.workers.json`;
function alive(pid) {
  if(!Number.isSafeInteger(pid)||pid<=0) return false;
  try {process.kill(pid,0);return true;} catch(error) {return error?.code==='EPERM';}
}
try {
  const status=JSON.parse(readFileSync(path,'utf8'));
  const now=Date.now();
  const supervisorAlive=alive(status.supervisorPid);
  const workers=Object.fromEntries(Object.entries(status.workers).map(([name,worker])=>{
    const fresh=Number.isSafeInteger(worker.lastRunAt)&&now-worker.lastRunAt<=Math.max(60_000,worker.intervalMs*3);
    const healthy=supervisorAlive&&alive(worker.pid)&&worker.state==='ok'&&fresh;
    return [name,{...worker,healthy}];
  }));
  const healthy=supervisorAlive&&Object.keys(workers).length===2&&Object.values(workers).every(worker=>worker.healthy);
  console.log(JSON.stringify({healthy,supervisorAlive,supervisorPid:status.supervisorPid,updatedAt:status.updatedAt,workers},null,2));
  if(!healthy) process.exitCode=1;
} catch(error) {
  console.error(`작업 상태를 읽을 수 없습니다: ${error instanceof Error?error.message:String(error)}`);
  process.exitCode=1;
}
