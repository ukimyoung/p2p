import { NextRequest } from 'next/server';
import { createAd, getAds, getSession } from '../../../../lib/data-store';
import { authenticatedAddress, jsonBody, responseError, sameOrigin, SESSION_COOKIE } from '../../../../lib/http';
export const runtime='nodejs';
export async function GET(request:NextRequest) {
  try {return Response.json({ads:await getAds(await getSession(request.cookies.get(SESSION_COOKIE)?.value)),demo:true},{headers:{'Cache-Control':'no-store'}});}
  catch(error) {return responseError(error);}
}
export async function POST(request:NextRequest) {
  try {sameOrigin(request);const address=await authenticatedAddress(request);const body=await jsonBody(request);return Response.json({ad:await createAd(address,body),demo:true},{status:201});}
  catch(error) {return responseError(error);}
}
