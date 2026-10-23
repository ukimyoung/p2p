import { NextRequest } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';
import { createChallenge, InputError } from '../../../../../lib/data-store';
import { jsonBody, responseError, sameOrigin } from '../../../../../lib/http';
export const runtime='nodejs';
export async function POST(request:NextRequest) {
  try {
    sameOrigin(request);
    const body=await jsonBody(request);
    if(typeof body.address!=='string'||!isAddress(body.address)) throw new InputError('유효한 EVM 주소가 필요합니다.');
    if(body.chainId!==11155111) throw new InputError('이 개발 버전은 Sepolia 서명만 지원합니다.');
    const address=getAddress(body.address);
    const nonce=generateSiweNonce();
    const origin=request.headers.get('origin')!;
    const message=createSiweMessage({domain:new URL(origin).host,address,statement:'Sign in to Peer development preview. No transaction will be sent.',uri:origin,version:'1',chainId:11155111,nonce,issuedAt:new Date(),expirationTime:new Date(Date.now()+5*60_000)});
    await createChallenge(address,message,nonce);
    return Response.json({message,expiresInSeconds:300});
  } catch(error) {return responseError(error);}
}
