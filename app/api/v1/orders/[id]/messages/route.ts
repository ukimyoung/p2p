import { NextRequest } from 'next/server';
import { getOrderConversation, postOrderMessage } from '../../../../../../lib/data-store';
import { authenticatedUserId, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';

export const runtime='nodejs';

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const address=await authenticatedUserId(request);
    const {id}=await params;
    return Response.json(await getOrderConversation(address,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const address=await authenticatedUserId(request);
    const {id}=await params;
    const {body,clientId}=await jsonBody(request);
    return Response.json({message:await postOrderMessage(address,id,body,clientId)},{status:201,headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}
