import { NextRequest } from 'next/server';
import { authenticatedUserId } from '../../../../../lib/http';
import { memberById } from '../../../../../lib/email-auth';
export const runtime='nodejs';
export async function GET(request:NextRequest) {
  try {return Response.json({user:await memberById(await authenticatedUserId(request))},{headers:{'Cache-Control':'no-store'}});}
  catch {return Response.json({user:null},{status:401,headers:{'Cache-Control':'no-store'}});}
}
