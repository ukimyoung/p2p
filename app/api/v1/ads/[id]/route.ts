import { NextRequest } from 'next/server';
import { changeAdStatus, updateAd } from '../../../../../lib/data-store';
import { authenticatedUserId, jsonBody, responseError, sameOrigin } from '../../../../../lib/http';
export const runtime='nodejs';
export async function PATCH(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const address=await authenticatedUserId(request);
    const body=await jsonBody(request);
    const {id}=await params;
    const ad=await (body.action===undefined
      ? updateAd(address,id,body,body.expectedVersion)
      : changeAdStatus(address,id,body.action,body.expectedVersion));
    return Response.json({ad,demo:true});
  } catch(error) {return responseError(error);}
}
