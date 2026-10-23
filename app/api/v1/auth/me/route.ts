import { NextRequest } from 'next/server';
import { authenticatedAddress } from '../../../../../lib/http';
export const runtime='nodejs';
export async function GET(request:NextRequest) {
  try {return Response.json({address:await authenticatedAddress(request)});}
  catch {return Response.json({address:null},{status:401});}
}
