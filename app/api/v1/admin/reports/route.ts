import { NextRequest } from 'next/server';
import { listAdminReports } from '../../../../../lib/data-store';
import { authenticatedUserId, responseError } from '../../../../../lib/http';

export const runtime='nodejs';

export async function GET(request:NextRequest) {
  try {
    const address=await authenticatedUserId(request);
    const url=new URL(request.url);
    return Response.json(await listAdminReports(address,url.searchParams.get('status')||'PENDING',url.searchParams.get('offset')||'0'),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}
