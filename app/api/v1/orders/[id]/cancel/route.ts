import { NextRequest } from 'next/server';
import { cancelOrder } from '../../../../../../lib/data-store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';
export const runtime='nodejs';
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {sameOrigin(request);const address=await authenticatedAddress(request);await jsonBody(request);const {id}=await params;return Response.json({order:await cancelOrder(address,id),demo:true});}
  catch(error) {return responseError(error);}
}
