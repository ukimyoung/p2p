import { getChainConfig, publicChainConfig } from '../../../../../lib/chain-config';
import { responseError } from '../../../../../lib/http';
export const runtime='nodejs';
export async function GET() {
  try {const config=getChainConfig();return Response.json(config?{enabled:true,config:publicChainConfig(config)}:{enabled:false},{headers:{'Cache-Control':'no-store'}});}
  catch(error) {return responseError(error);}
}
