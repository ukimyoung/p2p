'use client';
import { FormEvent, useEffect, useState } from 'react';
import { Ad, Asset, Side, filterOrdersByStatus, OrderStatusFilter } from '../lib/market';
import { stateName } from '../lib/i18n';
import { useLanguage } from './language-provider';
import OrderConversation from './order-conversation';
import OrderSafety from './order-safety';
import OrderStatusFilterBar from './order-status-filter';
import OrderTimeline, {type OrderEvent} from './order-timeline';

type Draft={side:Side;asset:Asset;price:string;total:string;min:string;max:string;minutes:string;validHours:string};
type IncomingOrder={id:string;ad_id:string;taker:string;amount:string;state:string;response_due_at:number|null;expires_at:number;terms_json:string|null};
const blank=():Draft=>({side:'buy',asset:'ETH',price:'2500',total:'1',min:'100',max:'1000',minutes:'15',validHours:'24'});
const stateLabel:Record<string,string>={ACTIVE:'진행 중',PAUSED:'일시중지',CLOSED:'종료',EXPIRED:'만료'};
async function send(path:string,method:'POST'|'PATCH',body:unknown) {
  const response=await fetch(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'광고 요청에 실패했습니다.');
  return data;
}
export default function MakerPanel({wallet,registerSignal,onMarketChanged,onNotice}:{wallet:string;registerSignal:number;onMarketChanged:()=>Promise<void>;onNotice:(message:string)=>void}) {
  const {t,language,locale}=useLanguage();
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
  useEffect(()=>{if(registerSignal>0){setEditing(null);setDraft(blank());setFormOpen(true);}},[registerSignal]);
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
    <div className="section-title"><div><span className="eyebrow">MY DEMO ADS</span><h2>{t('내 데모 광고','My demo ads')}</h2></div><button className="make-ad" onClick={()=>{setEditing(null);setDraft(blank());setFormOpen(current=>!current);}}>{formOpen?t('닫기','Close'):t('광고 만들기','Create ad')}</button></div>
    <p className="maker-caution">{t('데모 광고는 자산 잔액이나 담보를 확인하지 않습니다.','Demo ads do not verify asset balances or collateral.')}</p>
    {formOpen&&<form className="maker-form" onSubmit={event=>void save(event)}>
      <div className="maker-form-grid"><label>{t('거래 방향','Trade direction')}<select value={draft.side} disabled={!!editing} onChange={event=>field('side',event.target.value as Side)}><option value="buy">{t('구매 광고','Buy ad')}</option><option value="sell">{t('판매 광고','Sell ad')}</option></select></label><label>{t('자산','Asset')}<select value={draft.asset} disabled={!!editing} onChange={event=>field('asset',event.target.value as Asset)}><option value="ETH">ETH</option><option value="WBTC">WBTC</option></select></label><label>{t('단가','Price')} (USDC / {draft.asset})<input inputMode="decimal" required value={draft.price} onChange={event=>field('price',event.target.value)}/></label><label>{t('총 수량','Total amount')} ({draft.asset})<input inputMode="decimal" required value={draft.total} onChange={event=>field('total',event.target.value)}/></label><label>{t('최소 금액','Minimum amount')} (USDC)<input inputMode="decimal" required value={draft.min} onChange={event=>field('min',event.target.value)}/></label><label>{t('최대 금액','Maximum amount')} (USDC)<input inputMode="decimal" required value={draft.max} onChange={event=>field('max',event.target.value)}/></label><label>{t('응답 시간','Response time')} ({t('분','minutes')})<input type="number" min="5" max="60" required value={draft.minutes} onChange={event=>field('minutes',event.target.value)}/></label><label>{t('광고 유효기간','Ad validity')} ({t('시간','hours')})<input type="number" min="1" max="168" required value={draft.validHours} onChange={event=>field('validHours',event.target.value)}/></label></div>
      <button className="primary" disabled={saving} type="submit">{editing?t('광고 수정','Save ad'):t('데모 광고 등록','Post demo ad')}</button>
    </form>}
    {loading?<p>{t('내 광고를 불러오는 중입니다.','Loading your ads.')}</p>:ads.length?ads.map(ad=><article key={ad.id} className="owned-ad"><div><strong>{ad.side==='buy'?t('구매','Buy'):t('판매','Sell')} · {ad.asset} · {ad.price} USDC</strong><p>{language==='ko'?stateLabel[ad.status||'ACTIVE']:({ACTIVE:'Active',PAUSED:'Paused',CLOSED:'Closed',EXPIRED:'Expired'}[ad.status||'ACTIVE'])} · {t('가용','Available')} {ad.available} / {t('총','Total')} {ad.total} {ad.asset} · {t('한도','Limit')} {ad.min}–{ad.max} USDC</p>{ad.expiresAt&&<p>{t('만료','Expires')} {new Date(ad.expiresAt).toLocaleString(locale)}</p>}</div><div className="owned-actions">{ad.status!=='CLOSED'&&ad.status!=='EXPIRED'&&<button disabled={saving} onClick={()=>beginEdit(ad)}>{t('수정','Edit')}</button>}{ad.status==='ACTIVE'&&<button disabled={saving} onClick={()=>void status(ad,'pause')}>{t('일시중지','Pause')}</button>}{ad.status==='PAUSED'&&<button disabled={saving} onClick={()=>void status(ad,'resume')}>{t('재개','Resume')}</button>}{ad.status!=='CLOSED'&&ad.status!=='EXPIRED'&&<button disabled={saving} onClick={()=>void status(ad,'close')}>{t('종료','Close')}</button>}</div></article>):<p>{t('등록한 데모 광고가 없습니다.','No ads posted yet.')}</p>}
    <div className="incoming-orders">
      <div className="incoming-heading"><h3>{t('들어온 데모 예약','Incoming reservations')}</h3><button onClick={()=>void load().catch(error=>onNotice(error.message))}>{t('새로고침','Refresh')}</button></div>
      <OrderStatusFilterBar orders={incoming} value={orderFilter} onChange={value=>{setOrderFilter(value);setOpenHistory(null);}}/>
      {incoming.length===0?<p>{t('들어온 데모 예약이 없습니다.','No incoming reservations.')}</p>:visibleIncoming.length===0?<p className="order-filter-empty">{t('선택한 상태의 데모 예약이 없습니다.','No reservations in this status.')}</p>:visibleIncoming.map(order=><div className="incoming-item" key={order.id}>
        <div className="incoming-main"><div><strong>{order.amount} USDC · {stateName(order.state,language)}</strong><p>{t('거래자','Trader')} {order.taker.slice(0,8)} · {t('광고','Ad')} {order.ad_id.slice(0,8)}</p>{(order.state==='RESERVED'||order.state==='ACCEPTED')&&<p>{order.state==='RESERVED'?t('응답 기한','Response deadline'):t('수락 후 종료 기한','Reservation deadline')} {new Date((order.state==='RESERVED'?order.response_due_at:order.expires_at)||order.expires_at).toLocaleString(locale)}</p>}</div><div className="owned-actions">{order.state==='RESERVED'&&<><button disabled={saving} onClick={()=>void respond(order,'accept')}>{t('수락','Accept')}</button><button disabled={saving} onClick={()=>void respond(order,'decline')}>{t('거절','Decline')}</button></>}<button aria-expanded={openHistory===order.id} onClick={()=>void toggleHistory(order.id)}>{t('상태 이력','History')}</button></div></div>
        {openHistory===order.id&&<OrderTimeline events={history} wallet={wallet}/>}
        <OrderConversation id={order.id} wallet={wallet}/><OrderSafety id={order.id} onAdsChanged={onMarketChanged}/>
      </div>)}
    </div>
  </section>;
}
