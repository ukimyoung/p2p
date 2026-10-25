import { NextRequest, NextResponse } from 'next/server';
import { createSession } from '../../../../../lib/data-store';
import { confirmAccessToken } from '../../../../../lib/email-auth';
import { cookieOptions, jsonBody, responseError, sameOrigin, SESSION_COOKIE } from '../../../../../lib/http';

export const runtime='nodejs';
export async function POST(request:NextRequest) {
  try {
    sameOrigin(request);
    const member=await confirmAccessToken((await jsonBody(request)).accessToken);
    const token=await createSession(member.id);
    const response=NextResponse.json({user:member},{headers:{'Cache-Control':'no-store'}});
    response.cookies.set(SESSION_COOKIE,token,cookieOptions);
    return response;
  } catch(error) {return responseError(error);}
}
