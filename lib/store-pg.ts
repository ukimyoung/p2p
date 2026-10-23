import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { type QueryResultRow } from 'pg';
import { type Queryable, query, transaction } from './postgres';
import { type Ad, formatUnits, quote, units } from './market';
import { InputError } from './store';
import { isReportAdmin } from './admin-reports';

const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
async function rows<T extends QueryResultRow>(sql:string,values:unknown[]=[],client?:Queryable) {return (await query<T>(sql,values,client)).rows;}
async function row<T extends QueryResultRow>(sql:string,values:unknown[]=[],client?:Queryable) {return (await rows<T>(sql,values,client))[0];}
type AdRow=Ad & {available_units:string;total_units:string;maker_address:string|null;version:number;status:string;expires_at:number|null;created_at:number|null;created_order:number|null;trades:number;completion:number};
type OrderRow=QueryResultRow & {id:string;ad_id:string;taker:string;amount:string;asset_amount:string;state:string;expires_at:number;response_due_at:number|null};
const activeStates=['RESERVED','ACCEPTED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED'];
const closedStates=['DECLINED','CANCELLED','EXPIRED','SETTLED','REFUNDED','SIGNATURE_EXPIRED'];
const messageStates=new Set(activeStates);
const reportReasons=new Set(['SPAM','FRAUD','IMPERSONATION','OTHER']);
export const messageRetentionMs=30*24*60*60_000;
export const reportRetentionMs=180*24*60*60_000;
export const reportWindowMs=30*24*60*60_000;

function publicAd(ad:AdRow):Ad & {version:number;status:string} {
  const {available_units,total_units,maker_address,expires_at,created_at,created_order,trades,completion,...rest}=ad;
  const decimals=ad.asset==='ETH'?18:8;
  return {...rest,available:formatUnits(BigInt(available_units),decimals),total:formatUnits(BigInt(total_units),decimals),makerAddress:maker_address??undefined,expiresAt:expires_at??undefined,createdAt:created_at??undefined,createdOrder:created_order??undefined,demo:true};
}
type AdTerms={side:Ad['side'];asset:Ad['asset'];price:string;total:string;min:string;max:string;minutes:number;validHours:number;totalUnits:bigint};
function decimal(value:unknown,decimals:number,label:string) {
  if(typeof value!=='string'||!new RegExp(`^(0|[1-9]\\d{0,8})(\\.\\d{1,${decimals}})?$`).test(value)) throw new InputError(`${label} 형식을 확인하세요.`);
  const parsed=units(value,decimals);
  if(parsed===0n||parsed>units('100000000',decimals)) throw new InputError(`${label} 범위를 확인하세요.`);
  return {value:formatUnits(parsed,decimals),units:parsed};
}
function validateAdTerms(input:unknown):AdTerms {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new InputError('광고 조건을 확인하세요.');
  const body=input as Record<string,unknown>;
  if(body.side!=='buy'&&body.side!=='sell') throw new InputError('거래 방향을 확인하세요.');
  if(body.asset!=='ETH'&&body.asset!=='WBTC') throw new InputError('지원하지 않는 자산입니다.');
  const decimals=body.asset==='ETH'?18:8;
  const price=decimal(body.price,6,'단가');
  const total=decimal(body.total,decimals,'총 수량');
  const min=decimal(body.min,6,'최소 금액');
  const max=decimal(body.max,6,'최대 금액');
  if(total.units>units('1000000',decimals)||max.units<min.units||max.units>total.units*price.units/10n**BigInt(decimals)) throw new InputError('수량과 거래 한도가 일치하지 않습니다.');
  if(typeof body.minutes!=='number'||!Number.isInteger(body.minutes)||body.minutes<5||body.minutes>60) throw new InputError('응답 시간은 5~60분이어야 합니다.');
  if(typeof body.validHours!=='number'||!Number.isInteger(body.validHours)||body.validHours<1||body.validHours>168) throw new InputError('광고 유효기간은 1~168시간이어야 합니다.');
  return {side:body.side,asset:body.asset,price:price.value,total:total.value,min:min.value,max:max.value,minutes:body.minutes,validHours:body.validHours,totalUnits:total.units};
}
async function blockedBetween(client:Queryable,first:string,second:string) {
  return !!await row('SELECT 1 FROM p2p.user_blocks WHERE (blocker=$1 AND blocked=$2) OR (blocker=$2 AND blocked=$1)',[first.toLowerCase(),second.toLowerCase()],client);
}
async function recordOrderEvent(client:Queryable,id:string,state:string,actor:string,now:number) {
  await query('INSERT INTO p2p.order_events (order_id,state,actor,occurred_at) VALUES ($1,$2,$3,$4)',[id,state,actor,now],client);
}

export async function expireReservations(now=Date.now()) {
  await transaction(async client=>{
    await query("UPDATE p2p.ads SET status='EXPIRED',version=version+1 WHERE status IN ('ACTIVE','PAUSED') AND expires_at IS NOT NULL AND expires_at<=$1",[now],client);
    const candidates=await rows<{id:string;ad_id:string}>("SELECT id,ad_id FROM p2p.orders WHERE (state='RESERVED' AND COALESCE(response_due_at,expires_at)<=$1) OR (state='ACCEPTED' AND expires_at<=$1) ORDER BY ad_id,id",[now],client);
    for(const candidate of candidates) {
      await row('SELECT id FROM p2p.ads WHERE id=$1 FOR UPDATE',[candidate.ad_id],client);
      const order=await row<OrderRow>('SELECT * FROM p2p.orders WHERE id=$1 FOR UPDATE',[candidate.id],client);
      if(!order||!((order.state==='RESERVED'&&(order.response_due_at??order.expires_at)<=now)||(order.state==='ACCEPTED'&&order.expires_at<=now))) continue;
      await query('UPDATE p2p.ads SET available_units=available_units+$1,version=version+1 WHERE id=$2',[order.asset_amount,order.ad_id],client);
      await query("UPDATE p2p.orders SET state='EXPIRED' WHERE id=$1",[order.id],client);
      await recordOrderEvent(client,order.id,'EXPIRED','system',now);
    }
  });
}

export async function getAds(viewer?:string) {
  await expireReservations();
  const ads=await rows<AdRow>("SELECT * FROM p2p.ads WHERE status='ACTIVE' AND ($1::text IS NULL OR maker_address IS NULL OR NOT EXISTS (SELECT 1 FROM p2p.user_blocks b WHERE (b.blocker=$1 AND b.blocked=lower(maker_address)) OR (b.blocker=lower(maker_address) AND b.blocked=$1)))",[viewer?.toLowerCase()??null]);
  return ads.filter(ad=>BigInt(ad.available_units)*units(ad.price)/10n**BigInt(ad.asset==='ETH'?18:8)>=units(ad.min)).map(publicAd);
}
export async function getAd(id:string) {await expireReservations();const ad=await row<AdRow>("SELECT * FROM p2p.ads WHERE id=$1 AND status='ACTIVE'",[id]);return ad?publicAd(ad):undefined;}
export async function getMakerAds(address:string) {await expireReservations();return (await rows<AdRow>('SELECT * FROM p2p.ads WHERE maker_address=$1 ORDER BY created_order DESC',[address])).map(publicAd);}

export async function createAd(address:string,input:unknown) {
  const terms=validateAdTerms(input);
  const id=randomUUID();
  const maker=`${address.slice(0,6)}…${address.slice(-4)}`;
  const now=Date.now();
  const ad=await row<AdRow>("INSERT INTO p2p.ads (id,maker,maker_address,initials,side,asset,price,available_units,total_units,min,max,minutes,created_at,expires_at) VALUES ($1,$2,$3,'ME',$4,$5,$6,$7,$7,$8,$9,$10,$11,$12) RETURNING *",[id,maker,address,terms.side,terms.asset,terms.price,terms.totalUnits.toString(),terms.min,terms.max,terms.minutes,now,now+terms.validHours*60*60_000]);
  return publicAd(ad);
}

export async function updateAd(address:string,id:string,input:unknown,expectedVersion:unknown) {
  if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1) throw new InputError('광고 버전이 필요합니다.');
  await expireReservations();
  return transaction(async client=>{
    const ad=await row<AdRow>('SELECT * FROM p2p.ads WHERE id=$1 AND maker_address=$2 FOR UPDATE',[id,address],client);
    if(!ad) throw new InputError('내 광고를 찾을 수 없습니다.',404);
    if(ad.status==='CLOSED'||ad.status==='EXPIRED') throw new InputError('종료되거나 만료된 광고는 수정할 수 없습니다.',409);
    if(ad.version!==expectedVersion) throw new InputError('광고가 변경되었습니다. 새로고침 후 다시 시도하세요.',409);
    if(!input||typeof input!=='object'||Array.isArray(input)) throw new InputError('광고 조건을 확인하세요.');
    const body=input as Record<string,unknown>;
    if((body.side!==undefined&&body.side!==ad.side)||(body.asset!==undefined&&body.asset!==ad.asset)) throw new InputError('자산과 거래 방향은 변경할 수 없습니다.',409);
    const terms=validateAdTerms({...body,side:ad.side,asset:ad.asset});
    const reserved=await rows<{asset_amount:string}>("SELECT asset_amount FROM p2p.orders WHERE ad_id=$1 AND state=ANY($2::text[])",[id,activeStates],client);
    const reservedUnits=reserved.reduce((sum,order)=>sum+BigInt(order.asset_amount),0n);
    if(terms.totalUnits<reservedUnits) throw new InputError('예약된 수량보다 총 수량을 줄일 수 없습니다.',409);
    const updated=await row<AdRow>('UPDATE p2p.ads SET price=$1,total_units=$2,available_units=$3,min=$4,max=$5,minutes=$6,expires_at=$7,version=version+1 WHERE id=$8 RETURNING *',[terms.price,terms.totalUnits.toString(),(terms.totalUnits-reservedUnits).toString(),terms.min,terms.max,terms.minutes,Date.now()+terms.validHours*60*60_000,id],client);
    return publicAd(updated);
  });
}

export async function changeAdStatus(address:string,id:string,action:unknown,expectedVersion:unknown) {
  if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1) throw new InputError('광고 버전이 필요합니다.');
  if(action!=='pause'&&action!=='resume'&&action!=='close') throw new InputError('광고 작업을 확인하세요.');
  await expireReservations();
  return transaction(async client=>{
    const ad=await row<AdRow>('SELECT * FROM p2p.ads WHERE id=$1 AND maker_address=$2 FOR UPDATE',[id,address],client);
    if(!ad) throw new InputError('내 광고를 찾을 수 없습니다.',404);
    if(ad.version!==expectedVersion) throw new InputError('광고가 변경되었습니다. 새로고침 후 다시 시도하세요.',409);
    if(ad.status==='CLOSED'||ad.status==='EXPIRED'||(action==='pause'&&ad.status!=='ACTIVE')||(action==='resume'&&ad.status!=='PAUSED')) throw new InputError('현재 광고 상태에서 수행할 수 없습니다.',409);
    const next=action==='pause'?'PAUSED':action==='resume'?'ACTIVE':'CLOSED';
    const updated=await row<AdRow>('UPDATE p2p.ads SET status=$1,version=version+1 WHERE id=$2 RETURNING *',[next,id],client);
    return publicAd(updated);
  });
}

export async function reserveOrder(address:string,adId:string,amount:string,key:string,now=Date.now()) {
  if(!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new InputError('Idempotency-Key가 필요합니다.');
  if(typeof adId!=='string'||typeof amount!=='string') throw new InputError('광고와 금액을 확인하세요.');
  await expireReservations(now);
  return transaction(async client=>{
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${address.toLowerCase()}:${key}`],client);
    const old=await row<OrderRow>('SELECT * FROM p2p.orders WHERE taker=$1 AND idempotency_key=$2',[address,key],client);
    if(old) {
      if(old.ad_id!==adId||old.amount!==amount) throw new InputError('같은 요청 키에 다른 조건을 사용할 수 없습니다.',409);
      return old;
    }
    const adRow=await row<AdRow>("SELECT * FROM p2p.ads WHERE id=$1 AND status='ACTIVE' FOR UPDATE",[adId],client);
    if(!adRow||adRow.expires_at!==null&&adRow.expires_at<=now) throw new InputError('활성 광고를 찾을 수 없습니다.',404);
    if(adRow.maker_address===address) throw new InputError('자신의 광고는 예약할 수 없습니다.',403);
    if(adRow.maker_address&&await blockedBetween(client,address,adRow.maker_address)) throw new InputError('차단된 상대방의 광고는 예약할 수 없습니다.',403);
    const ad=publicAd(adRow);
    let estimate:ReturnType<typeof quote>;
    try {estimate=quote(ad,amount);} catch(error) {const message=(error as Error).message;throw new InputError(message,message.includes('거래 가능 수량')?409:400);}
    const assetUnits=units(estimate.assetAmount,ad.asset==='ETH'?18:8);
    if(assetUnits>BigInt(adRow.available_units)) throw new InputError('거래 가능 수량이 부족합니다.',409);
    const id=randomUUID();
    const responseDue=now+ad.minutes*60_000;
    const terms={id,adId,adVersion:adRow.version,maker:ad.maker,makerAddress:adRow.maker_address,taker:address,side:ad.side,asset:ad.asset,price:ad.price,amount,assetAmount:estimate.assetAmount,fee:estimate.fee,responseDueAt:responseDue};
    const claim=await query("UPDATE p2p.ads SET available_units=available_units-$1,version=version+1 WHERE id=$2 AND status='ACTIVE' AND available_units >= $1 RETURNING id",[assetUnits.toString(),adId],client);
    if(claim.rowCount!==1) throw new InputError('거래 가능 수량이 부족합니다.',409);
    const order=await row<OrderRow>("INSERT INTO p2p.orders (id,ad_id,taker,idempotency_key,amount,asset_amount,fee,price,terms_hash,terms_json,ad_version,created_at,response_due_at,expires_at,state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,'RESERVED') RETURNING *",[id,adId,address,key,amount,assetUnits.toString(),estimate.fee,ad.price,digest(JSON.stringify(terms)),JSON.stringify(terms),adRow.version,now,responseDue],client);
    await recordOrderEvent(client,id,'RESERVED',address,now);
    return order;
  });
}

export async function listOrders(address:string) {await expireReservations();return rows('SELECT id,ad_id,amount,asset_amount,fee,price,terms_hash,terms_json,ad_version,created_at,response_due_at,expires_at,state FROM p2p.orders WHERE taker=$1 ORDER BY created_at DESC',[address]);}
export async function listIncomingOrders(address:string) {await expireReservations();return rows('SELECT o.id,o.ad_id,o.taker,o.amount,o.asset_amount,o.fee,o.price,o.terms_hash,o.terms_json,o.ad_version,o.created_at,o.response_due_at,o.expires_at,o.state FROM p2p.orders o JOIN p2p.ads a ON a.id=o.ad_id WHERE a.maker_address=$1 ORDER BY o.created_at DESC',[address]);}
export async function getOrderDetail(address:string,id:string) {
  await expireReservations();
  const order=await row('SELECT o.* FROM p2p.orders o JOIN p2p.ads a ON a.id=o.ad_id WHERE o.id=$1 AND (o.taker=$2 OR a.maker_address=$2)',[id,address]);
  if(!order) throw new InputError('주문을 찾을 수 없습니다.',404);
  const events=await rows('SELECT state,actor,occurred_at FROM p2p.order_events WHERE order_id=$1 ORDER BY id',[id]);
  return {order,events};
}

async function closedAt(client:Queryable,id:string,state:string) {
  if(!closedStates.includes(state)) return undefined;
  const event=await row<{state:string;occurred_at:number}>('SELECT state,occurred_at FROM p2p.order_events WHERE order_id=$1 ORDER BY id DESC LIMIT 1',[id],client);
  return event?.state===state?event.occurred_at:undefined;
}
async function pruneOrder(client:Queryable,id:string,state:string,now:number) {
  const ended=await closedAt(client,id,state);
  if(ended===undefined) return {messages:0,reports:0};
  const messages=now-ended>=messageRetentionMs?(await query('DELETE FROM p2p.order_messages WHERE order_id=$1',[id],client)).rowCount??0:0;
  const reports=now-ended>=reportRetentionMs?(await query('DELETE FROM p2p.order_reports WHERE order_id=$1',[id],client)).rowCount??0:0;
  return {messages,reports};
}
export async function pruneSensitiveOrderData(now=Date.now()) {
  return transaction(async client=>{
    const orders=await rows<{id:string;state:string}>('SELECT id,state FROM p2p.orders WHERE state=ANY($1::text[])',[closedStates],client);
    const result={messages:0,reports:0};
    for(const order of orders) {
      const removed=await pruneOrder(client,order.id,order.state,now);
      result.messages+=removed.messages;
      result.reports+=removed.reports;
    }
    return result;
  });
}
async function safetyTarget(client:Queryable,address:string,id:string) {
  const targetRow=await row<{taker:string;maker_address:string|null}>('SELECT o.taker,a.maker_address FROM p2p.orders o JOIN p2p.ads a ON a.id=o.ad_id WHERE o.id=$1 AND (o.taker=$2 OR a.maker_address=$2)',[id,address],client);
  if(!targetRow) throw new InputError('주문을 찾을 수 없습니다.',404);
  const target=targetRow.taker.toLowerCase()===address.toLowerCase()?targetRow.maker_address:targetRow.taker;
  if(!target) throw new InputError('연결된 상대방 지갑이 없습니다.',409);
  return target.toLowerCase();
}
async function lockOrder(client:Queryable,id:string) {
  const source=await row<{ad_id:string}>('SELECT ad_id FROM p2p.orders WHERE id=$1',[id],client);
  if(!source) return undefined;
  await row('SELECT id FROM p2p.ads WHERE id=$1 FOR UPDATE',[source.ad_id],client);
  return row<OrderRow>('SELECT * FROM p2p.orders WHERE id=$1 FOR UPDATE',[id],client);
}
export async function getOrderSafety(address:string,id:string) {
  return transaction(async client=>{
    const target=await safetyTarget(client,address,id);
    const order=await row<{state:string}>('SELECT state FROM p2p.orders WHERE id=$1',[id],client);
    await pruneOrder(client,id,order.state,Date.now());
    const ended=await closedAt(client,id,order.state);
    const blocked=!!await row('SELECT 1 FROM p2p.user_blocks WHERE blocker=$1 AND blocked=$2',[address.toLowerCase(),target],client);
    const report=await row('SELECT id,reason,details,status,created_at,reviewed_at FROM p2p.order_reports WHERE order_id=$1 AND reporter=$2',[id,address.toLowerCase()],client)??null;
    return {target,blocked,report,reportable:ended===undefined||Date.now()-ended<reportWindowMs};
  });
}
export async function changeOrderBlock(address:string,id:string,action:unknown,now=Date.now()) {
  if(action!=='block'&&action!=='unblock') throw new InputError('차단 작업을 확인하세요.');
  return transaction(async client=>{
    const target=await safetyTarget(client,address,id);
    if(action==='block') await query('INSERT INTO p2p.user_blocks (blocker,blocked,created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',[address.toLowerCase(),target,now],client);
    else await query('DELETE FROM p2p.user_blocks WHERE blocker=$1 AND blocked=$2',[address.toLowerCase(),target],client);
    return {target,blocked:action==='block'};
  });
}
export async function reportOrderCounterparty(address:string,id:string,reason:unknown,details:unknown,now=Date.now()) {
  if(typeof reason!=='string'||!reportReasons.has(reason)) throw new InputError('신고 사유를 선택하세요.');
  if(typeof details!=='string'||details.trim().length<10||details.trim().length>1000) throw new InputError('신고 내용은 10~1000자로 입력하세요.');
  return transaction(async client=>{
    const order=await lockOrder(client,id);
    const target=await safetyTarget(client,address,id);
    await pruneOrder(client,id,order!.state,now);
    const existing=await row<{id:string;reason:string;details:string;status:string;created_at:number}>('SELECT id,reason,details,status,created_at FROM p2p.order_reports WHERE order_id=$1 AND reporter=$2',[id,address.toLowerCase()],client);
    if(existing) {
      if(existing.reason!==reason||existing.details!==details.trim()) throw new InputError('이 주문의 신고는 이미 접수되었습니다.',409);
      return existing;
    }
    const ended=await closedAt(client,id,order!.state);
    if(ended!==undefined&&now-ended>=reportWindowMs) throw new InputError('주문 종료 후 30일이 지나 신고 접수가 마감되었습니다.',409);
    const report={id:randomUUID(),reason,details:details.trim(),status:'PENDING',created_at:now};
    await query('INSERT INTO p2p.order_reports (id,order_id,reporter,reported,reason,details,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',[report.id,id,address.toLowerCase(),target,report.reason,report.details,report.status,report.created_at],client);
    return report;
  });
}
async function conversationOrder(client:Queryable,address:string,id:string) {
  const order=await row<{state:string;maker_address:string|null}>('SELECT o.state,a.maker_address FROM p2p.orders o JOIN p2p.ads a ON a.id=o.ad_id WHERE o.id=$1 AND (o.taker=$2 OR a.maker_address=$2)',[id,address],client);
  if(!order) throw new InputError('주문을 찾을 수 없습니다.',404);
  return order;
}
export async function getOrderConversation(address:string,id:string) {
  await expireReservations();
  return transaction(async client=>{
    const order=await conversationOrder(client,address,id);
    await pruneOrder(client,id,order.state,Date.now());
    const events=await rows<{id:number;state:string;actor:string;occurred_at:number}>('SELECT id,state,actor,occurred_at FROM p2p.order_events WHERE order_id=$1 ORDER BY id',[id],client);
    const messages=await rows<{id:number;sender:string;body:string;created_at:number}>('SELECT id,sender,body,created_at FROM p2p.order_messages WHERE order_id=$1 ORDER BY id',[id],client);
    const items=[...events.map(event=>({kind:'state' as const,id:`state-${event.id}`,at:event.occurred_at,actor:event.actor,state:event.state})),...messages.map(message=>({kind:'message' as const,id:`message-${message.id}`,at:message.created_at,actor:message.sender,body:message.body}))].sort((a,b)=>a.at-b.at||(a.kind===b.kind?Number(a.id.split('-')[1])-Number(b.id.split('-')[1]):a.kind==='state'?-1:1));
    return {items,writable:!!order.maker_address&&messageStates.has(order.state),hasCounterparty:!!order.maker_address};
  });
}
export async function postOrderMessage(address:string,id:string,body:unknown,clientId:unknown,now=Date.now()) {
  if(typeof body!=='string'||body.trim().length===0||body.trim().length>1000) throw new InputError('메시지는 1~1000자로 입력하세요.');
  if(typeof clientId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) throw new InputError('메시지 요청 ID를 확인하세요.');
  const clean=body.trim();
  await expireReservations(now);
  return transaction(async client=>{
    await lockOrder(client,id);
    const order=await conversationOrder(client,address,id);
    await pruneOrder(client,id,order.state,now);
    if(!order.maker_address) throw new InputError('대화 상대방이 없는 예시 주문입니다.',409);
    const previous=await row<{id:number;body:string;created_at:number}>('SELECT id,body,created_at FROM p2p.order_messages WHERE order_id=$1 AND sender=$2 AND client_id=$3',[id,address,clientId],client);
    if(previous) {
      if(previous.body!==clean) throw new InputError('요청 ID가 다른 메시지에 이미 사용되었습니다.',409);
      return {id:previous.id,body:previous.body,sender:address,created_at:previous.created_at};
    }
    if(!messageStates.has(order.state)) throw new InputError('종료된 주문에는 메시지를 보낼 수 없습니다.',409);
    const count=await row<{count:string}>('SELECT count(*) AS count FROM p2p.order_messages WHERE order_id=$1',[id],client);
    if(Number(count.count)>=500) throw new InputError('이 주문의 대화 한도에 도달했습니다.',409);
    const last=await row<{created_at:number}>('SELECT created_at FROM p2p.order_messages WHERE order_id=$1 AND sender=$2 ORDER BY id DESC LIMIT 1',[id,address],client);
    if(last&&now-last.created_at<2000) throw new InputError('메시지는 2초 간격으로 보낼 수 있습니다.',429);
    const saved=await row<{id:number}>('INSERT INTO p2p.order_messages (order_id,sender,client_id,body,created_at) VALUES ($1,$2,$3,$4,$5) RETURNING id',[id,address,clientId,clean,now],client);
    return {id:saved.id,body:clean,sender:address,created_at:now};
  });
}

export async function respondOrder(address:string,id:string,decision:'accept'|'decline',now=Date.now()) {
  if(decision!=='accept'&&decision!=='decline') throw new InputError('수락 또는 거절을 선택하세요.');
  await expireReservations(now);
  return transaction(async client=>{
    const order=await lockOrder(client,id);
    const ad=order?await row<{maker_address:string|null}>('SELECT maker_address FROM p2p.ads WHERE id=$1',[order.ad_id],client):undefined;
    if(!order||ad?.maker_address!==address) throw new InputError('담당 주문을 찾을 수 없습니다.',404);
    if(order.state!=='RESERVED') throw new InputError('이미 처리된 주문입니다.',409);
    if(decision==='accept') {
      const expires=now+15*60_000;
      await query("UPDATE p2p.orders SET state='ACCEPTED',expires_at=$1 WHERE id=$2",[expires,id],client);
      await recordOrderEvent(client,id,'ACCEPTED',address,now);
      return {id,state:'ACCEPTED',expires_at:expires};
    }
    await query('UPDATE p2p.ads SET available_units=available_units+$1,version=version+1 WHERE id=$2',[order.asset_amount,order.ad_id],client);
    await query("UPDATE p2p.orders SET state='DECLINED' WHERE id=$1",[id],client);
    await recordOrderEvent(client,id,'DECLINED',address,now);
    return {id,state:'DECLINED'};
  });
}
export async function cancelOrder(address:string,id:string) {
  await expireReservations();
  return transaction(async client=>{
    const order=await lockOrder(client,id);
    if(!order||order.taker!==address) throw new InputError('주문을 찾을 수 없습니다.',404);
    if(order.state!=='RESERVED'&&order.state!=='ACCEPTED') throw new InputError('이미 종료된 예약입니다.',409);
    await query('UPDATE p2p.ads SET available_units=available_units+$1,version=version+1 WHERE id=$2',[order.asset_amount,order.ad_id],client);
    await query("UPDATE p2p.orders SET state='CANCELLED' WHERE id=$1",[id],client);
    await recordOrderEvent(client,id,'CANCELLED',address,Date.now());
    return {id,state:'CANCELLED'};
  });
}

export async function createChallenge(address:string,message:string,nonce:string,now=Date.now()) {
  await transaction(async client=>{
    await query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`challenge:${address}`],client);
    await query('DELETE FROM p2p.challenges WHERE expires_at<=$1 OR address=$2',[now,address],client);
    await query('INSERT INTO p2p.challenges (nonce_hash,address,message,expires_at) VALUES ($1,$2,$3,$4)',[digest(nonce),address,message,now+5*60_000],client);
  });
}
export async function consumeChallenge(nonce:string,now=Date.now()) {
  const used=await row<{address:string;message:string;expires_at:number}>('DELETE FROM p2p.challenges WHERE nonce_hash=$1 RETURNING address,message,expires_at',[digest(nonce)]);
  return used&&used.expires_at>now?used:undefined;
}
export async function createSession(address:string,now=Date.now()) {
  const token=randomBytes(32).toString('base64url');
  await transaction(async client=>{
    await query('DELETE FROM p2p.sessions WHERE expires_at<=$1',[now],client);
    await query('INSERT INTO p2p.sessions (token_hash,address,expires_at) VALUES ($1,$2,$3)',[digest(token),address,now+24*60*60_000],client);
  });
  return token;
}
export async function getSession(token:string|undefined,now=Date.now()) {
  if(!token) return undefined;
  const session=await row<{address:string;expires_at:number}>('SELECT address,expires_at FROM p2p.sessions WHERE token_hash=$1',[digest(token)]);
  return session&&session.expires_at>now?session.address:undefined;
}
export async function deleteSession(token:string|undefined) {if(token) await query('DELETE FROM p2p.sessions WHERE token_hash=$1',[digest(token)]);}

function requireReportAdmin(address:string) {if(!isReportAdmin(address)) throw new InputError('운영자 권한이 없습니다.',403);}
type ReportRow=QueryResultRow & {id:string;order_id:string;reporter:string;reported:string;reason:string;details:string;status:string;created_at:number;reviewed_at:number|null;reviewed_by:string|null;review_note:string|null};
export async function listAdminReports(address:string,status:string|null='PENDING',offset:string|null='0') {
  requireReportAdmin(address);
  if(!['PENDING','CONFIRMED','DISMISSED','ALL'].includes(status||'')) throw new InputError('신고 상태 필터를 확인하세요.');
  if(!offset||!/^\d+$/.test(offset)||Number(offset)>10_000) throw new InputError('목록 위치를 확인하세요.');
  await pruneSensitiveOrderData();
  const all=status==='ALL';
  const reports=await rows(`SELECT r.id,r.order_id,r.reporter,r.reported,r.reason,r.status,r.created_at,r.reviewed_at,o.state AS order_state FROM p2p.order_reports r JOIN p2p.orders o ON o.id=r.order_id ${all?'':'WHERE r.status=$1'} ORDER BY r.created_at ASC,r.id ASC LIMIT 51 OFFSET $${all?1:2}`,all?[Number(offset)]:[status,Number(offset)]);
  return {reports:reports.slice(0,50),hasMore:reports.length>50,nextOffset:Number(offset)+50};
}
export async function getAdminReport(address:string,id:string) {
  requireReportAdmin(address);
  await pruneSensitiveOrderData();
  const report=await row<ReportRow>('SELECT * FROM p2p.order_reports WHERE id=$1',[id]);
  if(!report) throw new InputError('신고를 찾을 수 없습니다.',404);
  const order=await row('SELECT o.id,o.state,o.created_at,o.amount,o.asset_amount,o.price,o.taker,a.maker_address FROM p2p.orders o JOIN p2p.ads a ON a.id=o.ad_id WHERE o.id=$1',[report.order_id]);
  const messages=await rows('SELECT id,sender,body,created_at FROM p2p.order_messages WHERE order_id=$1 ORDER BY id',[report.order_id]);
  const events=await rows('SELECT state,actor,occurred_at FROM p2p.order_events WHERE order_id=$1 ORDER BY id',[report.order_id]);
  return {report,order,messages,events};
}
export async function reviewAdminReport(address:string,id:string,decision:unknown,note:unknown,now=Date.now()) {
  requireReportAdmin(address);
  if(decision!=='CONFIRMED'&&decision!=='DISMISSED') throw new InputError('심사 결과를 선택하세요.');
  if(typeof note!=='string'||note.trim().length<10||note.trim().length>500) throw new InputError('처리 메모는 10~500자로 입력하세요.');
  await pruneSensitiveOrderData(now);
  return transaction(async client=>{
    const report=await row<ReportRow>('SELECT * FROM p2p.order_reports WHERE id=$1 FOR UPDATE',[id],client);
    if(!report) throw new InputError('신고를 찾을 수 없습니다.',404);
    if(report.status!=='PENDING') {
      if(report.status===decision&&report.reviewed_by===address.toLowerCase()&&report.review_note===note.trim()) return report;
      throw new InputError('이미 처리된 신고입니다.',409);
    }
    return row<ReportRow>("UPDATE p2p.order_reports SET status=$1,reviewed_at=$2,reviewed_by=$3,review_note=$4 WHERE id=$5 AND status='PENDING' RETURNING *",[decision,now,address.toLowerCase(),note.trim(),id],client);
  });
}
