import { createHash, timingSafeEqual } from 'node:crypto';

export function cronAuthorization(request:Request):'authorized'|'unauthorized'|'unconfigured' {
  const secret=process.env.CRON_SECRET;
  if(!secret) return 'unconfigured';
  const authorization=request.headers.get('authorization');
  if(!authorization?.startsWith('Bearer ')) return 'unauthorized';
  const supplied=createHash('sha256').update(authorization.slice(7)).digest();
  const expected=createHash('sha256').update(secret).digest();
  return timingSafeEqual(supplied,expected)?'authorized':'unauthorized';
}

export function cronAccessResponse(request:Request):Response|undefined {
  const authorization=cronAuthorization(request);
  const headers={'Cache-Control':'no-store'};
  if(authorization==='unconfigured') return Response.json({ok:false},{status:503,headers});
  if(authorization==='unauthorized') return Response.json({ok:false},{status:401,headers});
}
