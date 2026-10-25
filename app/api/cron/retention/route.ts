import { cronAccessResponse } from '../../../../lib/cron-auth';
import { pruneSensitiveOrderData } from '../../../../lib/data-store';
import { postgresEnabled } from '../../../../lib/postgres';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;

export async function GET(request:Request) {
  const denied=cronAccessResponse(request);
  if(denied) return denied;
  try {
    if(!postgresEnabled()) throw new Error('보존 정리 Cron은 PostgreSQL 연결이 필요합니다.');
    const removed=await pruneSensitiveOrderData();
    console.log(`보존 정리 완료: 대화 ${removed.messages}건, 신고 ${removed.reports}건`);
    return Response.json({ok:true,removed},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {
    console.error('보존 정리 Cron 실패:',error);
    return Response.json({ok:false},{status:503,headers:{'Cache-Control':'no-store'}});
  }
}
