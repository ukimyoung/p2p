import { NextRequest } from 'next/server';
import { signUp } from '../../../../../lib/email-auth';
import { jsonBody, responseError, sameOrigin } from '../../../../../lib/http';

export const runtime='nodejs';
export async function POST(request:NextRequest) {
  try {
    sameOrigin(request);
    await signUp(await jsonBody(request),request.headers.get('origin')!);
    return Response.json({ok:true},{status:202,headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}
