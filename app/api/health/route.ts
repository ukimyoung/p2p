import { postgresEnabled, query } from '../../../lib/postgres';
import { db } from '../../../lib/store';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET() {
  try {
    if(postgresEnabled()) {
      const result=await query<{name:string|null}>("SELECT to_regclass('p2p.ads')::text AS name");
      if(result.rows[0]?.name!=='p2p.ads') throw new Error('PostgreSQL 스키마가 없습니다.');
    } else db().prepare('SELECT 1').get();
    return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    console.error('DB 상태 확인 실패:',error);
    return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
