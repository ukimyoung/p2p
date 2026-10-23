import { NextRequest, NextResponse } from 'next/server';
import { deleteSession } from '../../../../../lib/data-store';
import { jsonBody, responseError, sameOrigin, SESSION_COOKIE } from '../../../../../lib/http';
export const runtime='nodejs';
export async function POST(request:NextRequest) {
  try {sameOrigin(request);await jsonBody(request);await deleteSession(request.cookies.get(SESSION_COOKIE)?.value);const response=NextResponse.json({ok:true});response.cookies.delete(SESSION_COOKIE);return response;}
  catch(error) {return responseError(error);}
}
