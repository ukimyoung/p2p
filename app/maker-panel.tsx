'use client';
import { FormEvent, useEffect, useState } from 'react';
import { Ad, Asset, Side, filterOrdersByStatus, OrderStatusFilter, orderStateLabel } from '../lib/market';
import ChainOrderPanel from './chain-order-panel';
import OrderConversation from './order-conversation';
import OrderSafety from './order-safety';
import OrderStatusFilterBar from './order-status-filter';
import OrderTimeline, {type OrderEvent} from './order-timeline';

type Draft={side:Side;asset:Asset;price:string;total:string;min:string;max:string;minutes:string;validHours:string};
type IncomingOrder={id:string;ad_id:string;taker:string;amount:string;state:string;response_due_at:number|null;expires_at:number;terms_json:string|null};
const blank=():Draft=>({side:'buy',asset:'ETH',price:'2500',total:'1',min:'100',max:'1000',minutes:'15',validHours:'24'});
const stateLabel:Record<string,string>={ACTIVE:'진행 중',PAUSED:'일시중지',CLOSED:'종료',EXPIRED:'만료'};
const chainEligible=(terms:string|null)=>{try{return JSON.parse(terms||'{}').asset==='ETH';}catch{return false;}};
async function send(path:string,method:'POST'|'PATCH',body:unknown) {
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'광고 요청에 실패했습니다.');
  return data;
}
export default function MakerPanel({wallet,onMarketChanged,onNotice}:{wallet:string,onMarketChanged:()=>Promise<void>,onNotice:(message:string)=>void}) {
  const [ads,setAds]=useState<Ad[]>([]);
  const [incoming,setIncoming]=useState<IncomingOrder[]>([]);
  const [orderFilter,setOrderFilter]=useState<OrderStatusFilter>('all');
  const [openHistory,setOpenHistory]=useState<string|null>(null);
  const [history,setHistory]=useState<OrderEvent[]>([]);
  const [draft,setDraft]=useState<Draft>(blank);
  const [editing,setEditing]=useState<Ad|null>(null);
  const [formOpen,setFormOpen]=useState(false);
  const [saving,setSaving]=useState(false);
  const [loading,setLoading]=useState(true);
  async function load() {
    const [adsResponse,ordersResponse]=await Promise.all([
      fetch('/api/v1/me/ads',{cache:'no-store'}),fetch('/api/v1/me/incoming-orders',{cache:'no-store'}),
    ]);
    if(!adsResponse.ok||!ordersResponse.ok) throw new Error('내 광고와 예약 목록을 불러오지 못했습니다.');
    const [adsData,ordersData]=await Promise.all([adsResponse.json(),ordersResponse.json()]);
    setAds(adsData.ads);setIncoming(ordersData.orders);setOpenHistory(null);
  }
  useEffect(()=>{let active=true;Promise.all([fetch('/api/v1/me/ads',{cache:'no-store'}),fetch('/api/v1/me/incoming-orders',{cache:'no-store'})]).then(async responses=>{if(responses.some(response=>!response.ok))throw new Error('내 광고와 예약 목록을 불러오지 못했습니다.');return Promise.all(responses.map(response=>response.json()));}).then(([adsData,ordersData])=>{if(active){setAds(adsData.ads);setIncoming(ordersData.orders);}}).catch(error=>{if(active)onNotice(error.message);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[wallet]);
  const visibleIncoming=filterOrdersByStatus(incoming,orderFilter);
  const field=(key:keyof Draft,value:string)=>setDraft(current=>({...current,[key]:value}));
  function beginEdit(ad:Ad) {
    setEditing(ad);
    setDraft({side:ad.side,asset:ad.asset,price:ad.price,total:ad.total||ad.available,min:ad.min,max:ad.max,minutes:String(ad.minutes),validHours:String(Math.min(168,Math.max(1,Math.ceil(((ad.expiresAt||Date.now()+24*60*60_000)-Date.now())/3_600_000))))});
    setFormOpen(true);
  }
  async function save(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(saving)return;setSaving(true);
    try {
      const input={...draft,minutes:Number(draft.minutes),validHours:Number(draft.validHours)};
      if(editing) await send(`/api/v1/ads/${editing.id}`,'PATCH',{...input,expectedVersion:editing.version});
      else await send('/api/v1/ads','POST',input);
      await load();await onMarketChanged();setFormOpen(false);setEditing(null);
      onNotice(editing?'데모 광고를 수정했습니다. 기존 예약 조건은 유지됩니다.':'데모 광고를 등록했습니다. 자산 잔액이나 담보는 확인되지 않았습니다.');
    } catch(error) {await load().catch(()=>{});onNotice((error as Error).message);} finally {setSaving(false);}
  }
  async function status(ad:Ad,action:'pause'|'resume'|'close') {
    if(saving)return;setSaving(true);
    try {await send(`/api/v1/ads/${ad.id}`,'PATCH',{action,expectedVersion:ad.version});await load();await onMarketChanged();onNotice(action==='pause'?'광고를 일시중지했습니다. 기존 예약은 유지됩니다.':action==='resume'?'광고를 다시 공개했습니다.':'광고를 종료했습니다. 기존 예약은 만료 또는 취소될 때까지 유지됩니다.');}
    catch(error){await load().catch(()=>{});onNotice((error as Error).message);} finally {setSaving(false);}
  }
  async function respond(order:IncomingOrder,decision:'accept'|'decline') {
    if(saving)return;setSaving(true);
    try {
      await send(`/api/v1/orders/${order.id}/respond`,'POST',{decision});
      await load();await onMarketChanged();
      onNotice(decision==='accept'?'데모 예약을 수락했습니다. 자산은 이동하지 않으며 15분 뒤 만료됩니다.':'데모 예약을 거절하고 광고 잔량을 복구했습니다.');
    } catch(error) {await load().catch(()=>{});onNotice((error as Error).message);} finally {setSaving(false);}
  }
  async function toggleHistory(id:string) {
    if(openHistory===id){setOpenHistory(null);return;}
    try {const response=await fetch(`/api/v1/orders/${id}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'주문 이력을 불러오지 못했습니다.');setHistory(data.events);setOpenHistory(id);}
    catch(error){onNotice((error as Error).message);}
  }
  return <section id="my-ads" className="my-orders my-ads">
    <div className="section-title"><div><span className="eyebrow">MY DEMO ADS</span><h2>내 데모 광고</h2></div><button className="make-ad" onClick={()=>{setEditing(null);setDraft(blank());setFormOpen(current=>!current);}}>{formOpen?'닫기':'광고 만들기'}</button></div>
    <p className="maker-caution">데모 광고는 지갑 잔액이나 담보를 확인하지 않습니다. 로컬 Anvil이 설정된 개발 환경에서만 수락한 ETH 주문의 테스트 토큰 거래 흐름을 시험할 수 있습니다.</p>
    {formOpen&&<form className="maker-form" onSubmit={event=>void save(event)}>
      <div className="maker-form-grid"><label>거래 방향<select value={draft.side} disabled={!!editing} onChange={event=>field('side',event.target.value as Side)}><option value="buy">구매 광고</option><option value="sell">판매 광고</option></select></label><label>자산<select value={draft.asset} disabled={!!editing} onChange={event=>field('asset',event.target.value as Asset)}><option value="ETH">ETH</option><option value="WBTC">WBTC</option></select></label><label>단가 (USDC / {draft.asset})<input inputMode="decimal" required value={draft.price} onChange={event=>field('price',event.target.value)}/></label><label>총 수량 ({draft.asset})<input inputMode="decimal" required value={draft.total} onChange={event=>field('total',event.target.value)}/></label><label>최소 금액 (USDC)<input inputMode="decimal" required value={draft.min} onChange={event=>field('min',event.target.value)}/></label><label>최대 금액 (USDC)<input inputMode="decimal" required value={draft.max} onChange={event=>field('max',event.target.value)}/></label><label>응답 시간 (분)<input type="number" min="5" max="60" required value={draft.minutes} onChange={event=>field('minutes',event.target.value)}/></label><label>광고 유효기간 (시간)<input type="number" min="1" max="168" required value={draft.validHours} onChange={event=>field('validHours',event.target.value)}/></label></div>
      <button className="primary" disabled={saving} type="submit">{editing?'광고 수정':'데모 광고 등록'}</button>
    </form>}
    {loading?<p>내 광고를 불러오는 중입니다.</p>:ads.length?ads.map(ad=><article key={ad.id} className="owned-ad"><div><strong>{ad.side==='buy'?'구매':'판매'} · {ad.asset} · {ad.price} USDC</strong><p>{stateLabel[ad.status||'ACTIVE']} · 가용 {ad.available} / 총 {ad.total} {ad.asset} · 한도 {ad.min}–{ad.max} USDC</p>{ad.expiresAt&&<p>만료 {new Date(ad.expiresAt).toLocaleString('ko-KR')}</p>}</div><div className="owned-actions">{ad.status!=='CLOSED'&&ad.status!=='EXPIRED'&&<button disabled={saving} onClick={()=>beginEdit(ad)}>수정</button>}{ad.status==='ACTIVE'&&<button disabled={saving} onClick={()=>void status(ad,'pause')}>일시중지</button>}{ad.status==='PAUSED'&&<button disabled={saving} onClick={()=>void status(ad,'resume')}>재개</button>}{ad.status!=='CLOSED'&&ad.status!=='EXPIRED'&&<button disabled={saving} onClick={()=>void status(ad,'close')}>종료</button>}</div></article>):<p>등록한 데모 광고가 없습니다.</p>}
    <div className="incoming-orders">
      <div className="incoming-heading"><h3>들어온 데모 예약</h3><button onClick={()=>void load().catch(error=>onNotice(error.message))}>새로고침</button></div>
      <OrderStatusFilterBar orders={incoming} value={orderFilter} onChange={value=>{setOrderFilter(value);setOpenHistory(null);}}/>
      {incoming.length===0?<p>들어온 데모 예약이 없습니다.</p>:visibleIncoming.length===0?<p className="order-filter-empty">선택한 상태의 데모 예약이 없습니다.</p>:visibleIncoming.map(order=><div className="incoming-item" key={order.id}>
        <div className="incoming-main"><div><strong>{order.amount} USDC · {orderStateLabel[order.state]||order.state}</strong><p>거래자 {order.taker.slice(0,6)}…{order.taker.slice(-4)} · 광고 {order.ad_id.slice(0,8)}</p>{(order.state==='RESERVED'||order.state==='ACCEPTED')&&<p>{order.state==='RESERVED'?'응답 기한':'수락 후 종료 기한'} {new Date((order.state==='RESERVED'?order.response_due_at:order.expires_at)||order.expires_at).toLocaleString('ko-KR')}</p>}</div><div className="owned-actions">{order.state==='RESERVED'&&<><button disabled={saving} onClick={()=>void respond(order,'accept')}>수락</button><button disabled={saving} onClick={()=>void respond(order,'decline')}>거절</button></>}<button aria-expanded={openHistory===order.id} onClick={()=>void toggleHistory(order.id)}>상태 이력</button></div></div>
        {openHistory===order.id&&<OrderTimeline events={history} wallet={wallet}/>}
        <OrderConversation id={order.id} wallet={wallet}/><OrderSafety id={order.id} onAdsChanged={onMarketChanged}/>
        {order.state==='ACCEPTED'&&chainEligible(order.terms_json)||['CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED','SETTLED','REFUNDED','SIGNATURE_EXPIRED'].includes(order.state)?<ChainOrderPanel id={order.id} wallet={wallet} role="maker" onChanged={async()=>{await load();await onMarketChanged();}} onNotice={onNotice}/>:null}
      </div>)}
    </div>
  </section>;
}
