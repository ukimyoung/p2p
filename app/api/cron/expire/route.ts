import { cronAccessResponse } from '../../../../lib/cron-auth';
import { expireReservations } from '../../../../lib/data-store';
import { postgresEnabled } from '../../../../lib/postgres';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request) {
  const denied=cronAccessResponse(request);
  if(denied) return denied;
  try {
    if(!postgresEnabled()) throw new Error('예약 만료 Cron은 PostgreSQL 연결이 필요합니다.');
    await expireReservations();
    return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    console.error('예약 만료 Cron 실패:',error);
    return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
