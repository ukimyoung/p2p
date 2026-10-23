import { NextRequest } from 'next/server';
import { InputError, listOrders, reserveOrder } from '../../../../lib/data-store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin } from '../../../../lib/http';
export const runtime='nodejs';
export async function GET(request:NextRequest) {
  try {return Response.json({orders:await listOrders(await authenticatedAddress(request)),demo:true},{headers:{'Cache-Control':'no-store'}});}
  catch(error) {return responseError(error);}
}
export async function POST(request:NextRequest) {
  try {sameOrigin(request);const address=await authenticatedAddress(request);const body=await jsonBody(request);if(typeof body.adId!=='string'||typeof body.amount!=='string') throw new InputError('광고와 금액을 확인하세요.');const key=request.headers.get('idempotency-key')||'';const order=await reserveOrder(address,body.adId,body.amount,key);return Response.json({order,demo:true},{status:201});}
  catch(error) {return responseError(error);}
}
