import { existsSync } from 'node:fs';
import { db } from '../lib/store';
import { pruneSensitiveOrderData } from '../lib/data-store';
import { closePostgres, postgresEnabled } from '../lib/postgres';

async function main() {
  const path=process.env.P2P_DB_PATH;
  if(!postgresEnabled()&&(!path||!existsSync(path))) throw new Error('DATABASE_URL 또는 기존 SQLite DB 경로 P2P_DB_PATH를 지정하세요.');
  try {
    const removed=await pruneSensitiveOrderData();
    if(!postgresEnabled()) {
      const checkpoint=db().prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {busy:number};
      if(checkpoint.busy) throw new Error('WAL 정리를 완료하지 못했습니다. 활성 연결을 확인하고 다시 실행하세요.');
    }
    console.log(`삭제 완료: 대화 ${removed.messages}건, 신고 ${removed.reports}건`);
  } finally {
    if(postgresEnabled()) await closePostgres();
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
