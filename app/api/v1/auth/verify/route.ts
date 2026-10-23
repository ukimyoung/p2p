import { NextRequest, NextResponse } from 'next/server';
import { isHex, verifyMessage } from 'viem';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { consumeChallenge, createSession, InputError } from '../../../../../lib/data-store';
import { cookieOptions, jsonBody, responseError, sameOrigin, SESSION_COOKIE } from '../../../../../lib/http';
export const runtime='nodejs';
export async function POST(request:NextRequest) {
  try {
    sameOrigin(request);
    const body=await jsonBody(request);
    if(typeof body.message!=='string'||typeof body.signature!=='string'||!isHex(body.signature)) throw new InputError('서명 입력을 확인하세요.');
    const parsed=parseSiweMessage(body.message);
    if(!parsed.nonce) throw new InputError('서명 nonce가 없습니다.');
    const stored=await consumeChallenge(parsed.nonce);
    if(!stored||stored.message!==body.message||!validateSiweMessage({message:parsed,domain:new URL(request.headers.get('origin')!).host,nonce:parsed.nonce})) throw new InputError('만료되었거나 이미 사용된 로그인 요청입니다.',401);
    const valid=await verifyMessage({address:stored.address as `0x${string}`,message:stored.message,signature:body.signature as `0x${string}`});
    if(!valid) throw new InputError('지갑 서명이 일치하지 않습니다.',401);
    const token=await createSession(stored.address);
    const response=NextResponse.json({address:stored.address});
    response.cookies.set(SESSION_COOKIE,token,cookieOptions);
    return response;
  } catch(error) {return responseError(error);}
}
