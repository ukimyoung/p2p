import { NextRequest } from 'next/server';
import { getAdminReport, reviewAdminReport } from '../../../../../../lib/data-store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin } from '../../../../../../lib/http';

export const runtime='nodejs';

export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const address=await authenticatedAddress(request);
    const {id}=await params;
    return Response.json(await getAdminReport(address,id),{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}

export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    sameOrigin(request);
    const address=await authenticatedAddress(request);
    const {id}=await params;
    const {decision,note}=await jsonBody(request);
    return Response.json({report:await reviewAdminReport(address,id,decision,note)},{headers:{'Cache-Control':'no-store'}});
  } catch(error) {return responseError(error);}
}
