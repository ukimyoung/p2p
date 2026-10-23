import { NextRequest } from 'next/server';
import { changeOrderBlock, getOrderSafety, InputError, reportOrderCounterparty } from '../../../../../../lib/data-store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';

export const runtime='nodejs';

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const address=await authenticatedAddress(request);
    const {id}=await params;
    return Response.json(await getOrderSafety(address,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const address=await authenticatedAddress(request);
    const {id}=await params;
    const body=await jsonBody(request);
    if(body.action==='report')return Response.json({report:await reportOrderCounterparty(address,id,body.reason,body.details)},{status:201,headers:{'Cache-Control':'no-store'}});
    if(body.action==='block'||body.action==='unblock')return Response.json(await changeOrderBlock(address,id,body.action),{headers:{'Cache-Control':'no-store'}});
    throw new InputError('신고 또는 차단 작업을 선택하세요.');
  } catch(error) {return responseError(error);}
}
