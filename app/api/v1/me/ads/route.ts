import { NextRequest } from 'next/server';
import { getMakerAds } from '../../../../../lib/data-store';
import { authenticatedAddress, responseError } from '../../../../../lib/http';
export const runtime='nodejs';
export async function GET(request:NextRequest) {
  try {return Response.json({ads:await getMakerAds(await authenticatedAddress(request)),demo:true},{headers:{'Cache-Control':'no-store'}});}
  catch(error) {return responseError(error);}
}
