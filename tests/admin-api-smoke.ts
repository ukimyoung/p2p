import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

const base=process.env.P2P_TEST_BASE_URL||'http://localhost:3012';
const operator=privateKeyToAccount(`0x${'1'.padStart(64,'0')}`);
const maker=privateKeyToAccount(`0x${'2'.padStart(64,'0')}`);
const taker=privateKeyToAccount(`0x${'3'.padStart(64,'0')}`);
const post=(path:string,body:unknown,cookie?:string,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
const get=(path:string,cookie?:string)=>fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
async function checked(response:Response,status=200) {
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
}
async function login(account:typeof operator) {
  const challenge=await checked(await post('/api/v1/auth/challenge',{address:account.address,chainId:11155111}));
  const signature=await account.signMessage({message:challenge.message});
  const response=await post('/api/v1/auth/verify',{message:challenge.message,signature});
  await checked(response);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}
async function main() {
  const adminCookie=await login(operator);
  const makerCookie=await login(maker);
  const takerCookie=await login(taker);
  const ad=await checked(await post('/api/v1/ads',{side:'buy',asset:'ETH',price:'2000',total:'1',min:'100',max:'1500',minutes:15,validHours:24},makerCookie),201);
  const orderResponse=await fetch(base+'/api/v1/orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:takerCookie,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({adId:ad.ad.id,amount:'100'})});
  const order=(await checked(orderResponse,201)).order;
  await checked(await post(`/api/v1/orders/${order.id}/messages`,{body:'신고 검토용 주문 대화입니다.',clientId:crypto.randomUUID()},makerCookie),201);
  const safetyPath=`/api/v1/orders/${order.id}/safety`;
  const report=(await checked(await post(safetyPath,{action:'report',reason:'FRAUD',details:'약정과 다른 조건을 제시했습니다.'},takerCookie),201)).report;
  const list='/api/v1/admin/reports';
  const detail=`${list}/${report.id}`;
  assert.equal((await get(list)).status,401);
  assert.equal((await get(list,takerCookie)).status,403);
  assert.equal((await get(detail,takerCookie)).status,403);
  assert.equal((await post(detail,{decision:'CONFIRMED',note:'확인한 대화 내용과 신고 사유가 일치합니다.'},takerCookie)).status,403);
  assert.equal((await get('/admin/reports',takerCookie)).status,404);
  assert.equal((await get('/admin/reports',adminCookie)).status,200);
  const queue=await checked(await get(list,adminCookie));
  assert.equal(queue.reports.length,1);
  assert.equal(queue.reports[0].id,report.id);
  assert.equal('details' in queue.reports[0],false);
  assert.equal((await get(list+'?status=WRONG',adminCookie)).status,400);
  const evidence=await checked(await get(detail,adminCookie));
  assert.equal(evidence.report.details,'약정과 다른 조건을 제시했습니다.');
  assert.equal(evidence.messages[0].body,'신고 검토용 주문 대화입니다.');
  const note='확인한 대화 내용과 신고 사유가 일치합니다.';
  assert.equal((await post(detail,{decision:'CONFIRMED',note},adminCookie,'https://attacker.example')).status,403);
  assert.equal((await post(detail,{decision:'CONFIRMED',note:'짧음'},adminCookie)).status,400);
  const reviewed=(await checked(await post(detail,{decision:'CONFIRMED',note},adminCookie))).report;
  assert.equal(reviewed.status,'CONFIRMED');
  assert.equal(reviewed.reviewed_by,operator.address.toLowerCase());
  assert.equal((await checked(await post(detail,{decision:'CONFIRMED',note},adminCookie))).report.reviewed_at,reviewed.reviewed_at);
  assert.equal((await post(detail,{decision:'DISMISSED',note},adminCookie)).status,409);
  assert.equal((await checked(await get(list,adminCookie))).reports.length,0);
  assert.equal((await checked(await get(list+'?status=CONFIRMED',adminCookie))).reports.length,1);
  const participant=(await checked(await get(safetyPath,takerCookie))).report;
  assert.equal(participant.status,'CONFIRMED');
  assert.equal('review_note' in participant,false);
  console.log('PASS: operator allowlist, private report evidence, one-time review, participant status and admin page.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
