import { NextRequest } from 'next/server';
import { getChainConfig, verifyChainConfig } from '../../../../../../lib/chain-config';
import { getChainOrder, noteChainTx, prepareChainOrder, releaseExpiredSignature, signChainOrder } from '../../../../../../lib/chain-orders';
import { syncChain } from '../../../../../../lib/chain-indexer';
import { InputError } from '../../../../../../lib/store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';
import { postgresEnabled } from '../../../../../../lib/postgres';
export const runtime='nodejs';

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    if(postgresEnabled()) throw new InputError('호스팅 환경에서 로컬 체인 기능은 비활성화되어 있습니다.',503);
    const address=await authenticatedAddress(request);
    const {id}=await params;
    const before=getChainOrder(address,id);
    if(before.chain) await syncChain();
    return Response.json(getChainOrder(address,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    if(postgresEnabled()) throw new InputError('호스팅 환경에서 로컬 체인 기능은 비활성화되어 있습니다.',503);
    sameOrigin(request);
    const address=await authenticatedAddress(request);
    const body=await jsonBody(request);
    const {id}=await params;
    const config=getChainConfig();
    if(!config) throw new InputError('로컬 체인이 설정되지 않았습니다.',503);
    if(body.action==='prepare') {
      await verifyChainConfig(config);
      prepareChainOrder(address,id,config);
    } else if(body.action==='sign') await signChainOrder(address,id,body.signature,config);
    else if(body.action==='release') await releaseExpiredSignature(address,id,config);
    else if(body.action==='tx') noteChainTx(address,id,body.txAction,body.hash);
    else if(body.action==='sync') await syncChain();
    else throw new InputError('체인 주문 작업을 확인하세요.');
    return Response.json(getChainOrder(address,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}
