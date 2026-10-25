import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createSession } from '../lib/store-pg';
import { query } from '../lib/postgres';
const base=process.env.P2P_TEST_BASE_URL||'http://localhost:3012';
const operator={id:'11111111-1111-4111-8111-111111111111'};
const maker={id:'22222222-2222-4222-8222-222222222222'};
const taker={id:'33333333-3333-4333-8333-333333333333'};
const post=(path:string,body:unknown,cookie?:string,origin=base)=>fetch(base+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
const get=(path:string,cookie?:string)=>fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
async function checked(response:Response,status=200) {
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
}
async function login(account:{id:string}) {
  await query('INSERT INTO p2p.member_profiles (user_id,email,country_code,phone_e164,email_verified_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[account.id,`${account.id}@example.test`,'KR','+821012345678',Date.now()]);
  return `peer_session=${await createSession(account.id)}`;
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
  assert.equal(reviewed.reviewed_by,operator.id);
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
