import { NextRequest } from 'next/server';
import { getOrderDetail } from '../../../../../lib/data-store';
import { authenticatedAddress, responseError } from '../../../../../lib/http';
export const runtime='nodejs';
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {const address=await authenticatedAddress(request);const {id}=await params;return Response.json({...await getOrderDetail(address,id),demo:true},{headers:{'Cache-Control':'no-store'}});}
  catch(error) {return responseError(error);}
}
