import 'server-only';
import { NextRequest } from 'next/server';
import { InputError, getSession } from './data-store';
export const SESSION_COOKIE='peer_session';
export const cookieOptions={httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'strict' as const,path:'/',maxAge:24*60*60};
export function sameOrigin(request:NextRequest) {
  const origin=request.headers.get('origin');
  const host=request.headers.get('host');
  let url:URL;
  try {url=new URL(origin||'');} catch {throw new InputError('요청 출처를 확인할 수 없습니다.',403);}
  const local=host?.startsWith('localhost:')||host==='localhost'||host?.startsWith('127.0.0.1:')||host==='127.0.0.1';
  if(!host||url.host!==host||(url.protocol!=='https:'&&!(local&&url.protocol==='http:'))) throw new InputError('요청 출처를 확인할 수 없습니다.',403);
  if(!request.headers.get('content-type')?.startsWith('application/json')) throw new InputError('JSON 요청이 필요합니다.',415);
}
export async function jsonBody(request:NextRequest) {
  const body=await request.text();
  if(body.length>4096) throw new InputError('요청이 너무 큽니다.',413);
  try {const parsed=JSON.parse(body);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)) throw new Error();return parsed as Record<string,unknown>;} catch {throw new InputError('올바른 JSON 요청이 필요합니다.');}
}
export async function authenticatedAddress(request:NextRequest) {
  const address=await getSession(request.cookies.get(SESSION_COOKIE)?.value);
  if(!address) throw new InputError('지갑 로그인이 필요합니다.',401);
  return address;
}
export function responseError(error:unknown) {
  if(error instanceof InputError) return Response.json({error:error.message},{status:error.status});
  console.error(error);
  return Response.json({error:'서버 오류가 발생했습니다.'},{status:500});
}
