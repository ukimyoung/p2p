import { existsSync } from 'node:fs';
import { expireReservations } from '../lib/data-store';
import { postgresEnabled } from '../lib/postgres';

const path=process.env.P2P_DB_PATH;
if(!postgresEnabled()&&(!path||!existsSync(path))) throw new Error('DATABASE_URL 또는 기존 SQLite DB 경로 P2P_DB_PATH를 지정하세요.');

const interval=Number(process.env.P2P_EXPIRY_INTERVAL_MS??30_000);
if(!Number.isSafeInteger(interval)||interval<100) throw new Error('P2P_EXPIRY_INTERVAL_MS는 100 이상인 정수여야 합니다.');

let stopping=false;
let timer:ReturnType<typeof setTimeout>|undefined;
function stop() {
  stopping=true;
  if(timer) clearTimeout(timer);
  if(process.connected) process.disconnect();
}
process.once('SIGINT',stop);
process.once('SIGTERM',stop);
if(process.send) process.once('disconnect',stop);

function report(ok:boolean,error?:unknown) {
  try {process.send?.({kind:'p2p-worker-sweep',ok,at:Date.now(),error:ok?undefined:String(error instanceof Error?error.message:error).slice(0,200)});}
  catch { /* The supervisor may have exited after this sweep started. */ }
}

let announced=false;
async function sweep() {
  try {
    await expireReservations();
    if(!announced) {console.log(`예약 만료 작업 시작 (${interval}ms 간격)`);announced=true;}
    report(true);
  } catch(error) {
    console.error('예약 만료 작업 실패; 다음 주기에 다시 시도합니다.',error);
    report(false,error);
  } finally {
    if(!stopping) timer=setTimeout(()=>void sweep(),interval);
  }
}
void sweep();
