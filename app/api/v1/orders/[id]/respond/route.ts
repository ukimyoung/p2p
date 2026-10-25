import { NextRequest } from 'next/server';
import { InputError, respondOrder } from '../../../../../../lib/data-store';
import { authenticatedUserId, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';
export const runtime='nodejs';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const address=await authenticatedUserId(request);
    const body=await jsonBody(request);
    if(body.decision!=='accept'&&body.decision!=='decline') throw new InputError('수락 또는 거절을 선택하세요.');
    const {id}=await params;
    return Response.json({order:await respondOrder(address,id,body.decision),demo:true});
  } catch(error) {return responseError(error);}
}
