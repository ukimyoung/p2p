'use client';
import { useEffect, useRef, useState } from 'react';
import { Asset, Side, Ad, AdSort, ads as fixtureAds, filterAds, filterOrdersByStatus, OrderStatusFilter, orderStateLabel, quote } from '../lib/market';
import MakerPanel from './maker-panel';
import ChainOrderPanel from './chain-order-panel';
import OrderConversation from './order-conversation';
import OrderSafety from './order-safety';
import OrderStatusFilterBar from './order-status-filter';
import OrderTimeline, {type OrderEvent} from './order-timeline';
type WalletProvider = {request: (args:{method:string;params?:unknown[]})=>Promise<unknown>;on?:(event:string,listener:(value:unknown)=>void)=>void;removeListener?:(event:string,listener:(value:unknown)=>void)=>void};
type DemoOrder = {id:string;ad_id:string;amount:string;fee:string;state:string;response_due_at:number|null;expires_at:number;terms_hash:string;terms_json:string|null};
const provider = () => (window as Window & {ethereum?:WalletProvider}).ethereum;
async function post(path:string, body:unknown, headers:Record<string,string>={}) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error || '요청을 완료하지 못했습니다.');
  return data;
}
const money = (n: string) => Number(n).toLocaleString('en-US', {maximumFractionDigits: 6});
const chainEligible=(terms:string|null)=>{try{return JSON.parse(terms||'{}').asset==='ETH';}catch{return false;}};
export default function Home() {
  const [side, setSide] = useState<Side>('buy');
  const [asset, setAsset] = useState<Asset>('ETH');
  const [amount, setAmount] = useState('');
  const [adSort, setAdSort] = useState<AdSort>('best_price');
  const [selected, setSelected] = useState<Ad | null>(null);
  const [orderAmount, setOrderAmount] = useState('');
  const [notice, setNotice] = useState('');
  const [wallet, setWallet] = useState<string|null>(null);
  const [marketAds, setMarketAds] = useState<Ad[]>(fixtureAds);
  const [orders, setOrders] = useState<DemoOrder[]>([]);
  const [orderFilter, setOrderFilter] = useState<OrderStatusFilter>('all');
  const [openOrderId, setOpenOrderId] = useState<string|null>(null);
  const [orderEvents, setOrderEvents] = useState<OrderEvent[]>([]);
  const [showOrders, setShowOrders] = useState(false);
  const [showMaker, setShowMaker] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const list = filterAds(side, asset, amount, marketAds, adSort);
  const visibleOrders = filterOrdersByStatus(orders,orderFilter);
  async function refreshAds() {const response=await fetch('/api/v1/ads',{cache:'no-store'});if(response.ok) setMarketAds((await response.json()).ads);}
  async function refreshOrders() {const response=await fetch('/api/v1/orders',{cache:'no-store'});if(response.ok){setOrders((await response.json()).orders);setOpenOrderId(null);}}
  async function toggleOrderHistory(id:string) {
    if(openOrderId===id){setOpenOrderId(null);return;}
    try {const response=await fetch(`/api/v1/orders/${id}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'주문 이력을 불러오지 못했습니다.');setOrderEvents(data.events);setOpenOrderId(id);}
    catch(error){setNotice((error as Error).message);}
  }
  useEffect(()=>{fetch('/api/v1/auth/me',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(data=>{if(data?.address)setWallet(data.address)}).catch(()=>{});},[]);
  useEffect(()=>{void refreshAds();},[wallet]);
  useEffect(()=>{
    if(!wallet)return;
    const ethereum=provider();
    if(!ethereum)return;
    let active=true;
    let invalidating=false;
    const onAccounts=(value:unknown)=>{
      const accounts=Array.isArray(value)?value as string[]:[];
      if(!active||invalidating||accounts.some(account=>typeof account==='string'&&account.toLowerCase()===wallet.toLowerCase()))return;
      invalidating=true;
      void post('/api/v1/auth/logout',{}).catch(()=>{}).finally(()=>{
        if(!active)return;
        setWallet(null);setOrders([]);setOpenOrderId(null);setShowOrders(false);setShowMaker(false);setSelected(null);
        setNotice('지갑 계정이 변경되어 로그인 세션을 종료했습니다. 새 계정으로 다시 로그인하세요.');
      });
    };
    ethereum.on?.('accountsChanged',onAccounts);
    void ethereum.request({method:'eth_accounts'}).then(onAccounts).catch(()=>{});
    return()=>{active=false;ethereum.removeListener?.('accountsChanged',onAccounts);};
  },[wallet]);
  async function connect() {
    if(busy) return;
    if(wallet) {try {await post('/api/v1/auth/logout',{});setWallet(null);setOrders([]);setShowOrders(false);setShowMaker(false);setNotice('지갑 로그인 세션이 종료되었습니다.');} catch(e){setNotice((e as Error).message);} return;}
    const ethereum=provider();
    if(!ethereum){setNotice('EVM 브라우저 지갑이 필요합니다. 지갑 확장 기능을 설치한 뒤 다시 시도하세요.');return;}
    setBusy(true);
    try {
      const accounts=await ethereum.request({method:'eth_requestAccounts'}) as string[];
      if(!accounts?.[0]) throw new Error('지갑 계정을 선택하세요.');
      const chain=await ethereum.request({method:'eth_chainId'});
      if(chain!=='0xaa36a7') throw new Error('개발 프리뷰 로그인은 Sepolia 네트워크에서만 가능합니다. 지갑 네트워크를 바꾼 뒤 다시 시도하세요.');
      const {message}=await post('/api/v1/auth/challenge',{address:accounts[0],chainId:11155111});
      const signature=await ethereum.request({method:'personal_sign',params:[message,accounts[0]]}) as string;
      const result=await post('/api/v1/auth/verify',{message,signature});
      setWallet(result.address);setNotice('지갑 서명으로 로그인했습니다. 데모 예약은 자산을 이동하지 않습니다.');
    } catch(e){setNotice((e as Error).message);} finally {setBusy(false);}
  }
  async function reserve() {
    if(!selected||!estimate||busy) return;
    if(!wallet){setSelected(null);setNotice('데모 예약 전에 지갑 서명으로 로그인하세요.');return;}
    setBusy(true);
    try {
      const result=await post('/api/v1/orders',{adId:selected.id,amount:orderAmount},{'Idempotency-Key':crypto.randomUUID()});
      setSelected(null);await refreshAds();await refreshOrders();setNotice(`데모 예약 ${result.order.id.slice(0,8)}이 생성되었습니다. 광고주 응답 기한은 ${selected.minutes}분이며 자금은 이동하지 않습니다.`);
    } catch(e){setNotice((e as Error).message);await refreshAds();} finally {setBusy(false);}
  }
  async function cancel(id:string) {try {await post(`/api/v1/orders/${id}/cancel`,{});await refreshOrders();await refreshAds();if(openOrderId===id){setOpenOrderId(null);}setNotice('데모 예약을 취소하고 광고 잔량을 복구했습니다.');}catch(e){setNotice((e as Error).message);}}
  let estimate: ReturnType<typeof quote> | undefined; let error = '';
  if (selected) {try { estimate = quote(selected, orderAmount); } catch (e) {error = (e as Error).message;}}
  useEffect(() => { if (selected) dialog.current?.showModal(); else dialog.current?.close(); }, [selected]);
  function choose(ad: Ad) {setOrderAmount(amount || ad.min); setSelected(ad);}
  return <>
    <div className="demo-banner"><span className="pulse"/> 개발 프리뷰 · 광고와 가격은 데모 정보입니다. 선택한 로컬 Anvil 거래에는 테스트 토큰만 사용합니다.</div>
    <header><a className="logo" href="/" aria-label="Peer 홈"><span className="brand-mark">↗</span> peer<span className="logo-dot">.</span></a><nav aria-label="주 메뉴"><a className="active" href="#market">P2P 마켓</a><a href="#how">이용 방법</a></nav><div className="header-actions">{wallet && <><button className="orders-link" onClick={()=>{setShowMaker(v=>!v);setShowOrders(false);}}>내 광고</button><button className="orders-link" onClick={()=>{setShowOrders(v=>!v);setShowMaker(false);void refreshOrders();}}>내 예약</button></>}<button className="wallet" disabled={busy} onClick={()=>void connect()}><span>◈</span> {wallet?`${wallet.slice(0,6)}…${wallet.slice(-4)}`:'지갑 로그인'} <small>{wallet?'로그아웃':'Sepolia'}</small></button></div></header>
    <main>
      <section className="hero"><div className="eyebrow"><span/> YOUR WALLET. YOUR TRADE.</div><h1>사람과 사람 사이,<br/><em>더 투명한 암호화폐 거래.</em></h1><p>원하는 조건을 찾고, 내 지갑으로 직접 거래하세요.<br/>암호화폐와 암호화폐를 연결하는 새로운 P2P 마켓.</p><div className="hero-tags"><span>◈ 개인지갑 기반</span><span>⇄ Crypto to Crypto</span><span>◇ 온체인 에스크로 설계</span></div><div className="orbit" aria-hidden="true"><div className="orbit-ring"/><div className="coin eth">Ξ</div><div className="exchange">⇄</div><div className="coin usdc">$</div><div className="orbit-label">DIRECT. TRANSPARENT. PEER.</div></div></section>
      <section id="market" className="market"><div className="section-title"><div><span className="eyebrow">THE MARKETPLACE</span><h2>나에게 맞는 거래 찾기</h2></div><span className="network"><i/> 서명 테스트: Sepolia · 거래 체인 미선정</span></div>
        <div className="market-panel"><div className="panel-top"><div className="tabs" aria-label="거래 방향"><button aria-pressed={side==='buy'} className={side==='buy'?'selected':''} onClick={()=>setSide('buy')}>구매하기</button><button aria-pressed={side==='sell'} className={side==='sell'?'selected':''} onClick={()=>setSide('sell')}>판매하기</button></div><span className="pair-note">{side==='buy'?`USDC로 ${asset} 구매`:`${asset} 판매 후 USDC 수취`}</span></div>
        <div className="filters"><label>거래 자산<select aria-label="거래 자산" value={asset} onChange={e=>setAsset(e.target.value as Asset)}><option>ETH</option><option>WBTC</option></select></label><label className="amount-filter">거래 금액<div className="input-wrap"><input inputMode="decimal" value={amount} placeholder="금액 입력" onChange={e=>setAmount(e.target.value)} aria-label="USDC 기준 거래 금액"/><span>USDC</span></div></label><label>정렬 기준<select value={adSort} onChange={e=>setAdSort(e.target.value as AdSort)}><option value="best_price">유리한 가격순</option><option value="available_desc">거래 가능 수량 많은 순</option><option value="newest">최근 등록순</option></select></label><button className="reset" onClick={()=>setAmount('')}>↺ 초기화</button></div>
        <div className="results-line"><span>거래 가능한 광고 <strong>{list.length}</strong></span><span className="mobile-scroll-hint">← 표를 좌우로 밀어 보기 →</span><span className="price-note">예시 가격 · 실시간 시세 아님</span></div>
        <div className="table-scroll"><table><thead><tr><th>광고주</th><th>가격 <small>USDC</small></th><th>거래 가능 수량 / 한도</th><th>거래 조건</th><th><span className="sr-only">거래 선택</span></th></tr></thead><tbody>{list.map(ad=><tr key={ad.id}><td><div className="maker"><span className="avatar">{ad.initials}</span><div><strong>{ad.maker}</strong><p>데모 광고</p></div></div></td><td><span className="price">{money(ad.price)}</span><small className="unit">USDC / {ad.asset}</small></td><td><strong className="available">{ad.available} {ad.asset}</strong><p className="limit">{money(ad.min)} – {money(ad.max)} USDC</p></td><td><span className="token-pill">USDC ⇄ {ad.asset}</span><p className="limit">◷ {ad.minutes}분 이내 응답</p></td><td><button className={`trade ${side}`} disabled={!!wallet&&ad.makerAddress===wallet} onClick={()=>choose(ad)}>{wallet&&ad.makerAddress===wallet?'내 광고':<>{ad.asset} {side==='buy'?'구매':'판매'} <span>↗</span></>}</button></td></tr>)}</tbody></table></div>
        {!list.length && <div className="empty"><span>⌕</span><h3>조건에 맞는 광고가 없습니다</h3><p>거래 금액이나 자산을 변경해 보세요.</p><button className="reset" onClick={()=>setAmount('')}>금액 필터 지우기</button></div>}
        <div className="panel-foot">ⓘ WBTC는 EVM 체인의 래핑 자산입니다. 네이티브 BTC 및 크로스체인 거래는 지원 범위에서 제외됩니다.</div></div>
      </section>
      {showMaker && wallet && <MakerPanel wallet={wallet} onMarketChanged={refreshAds} onNotice={setNotice}/>}
      {showOrders && wallet && <section className="my-orders">
        <div className="section-title"><div><span className="eyebrow">MY DEMO ORDERS</span><h2>내 데모 예약</h2></div><button className="make-ad" onClick={()=>void refreshOrders()}>새로고침</button></div>
        <OrderStatusFilterBar orders={orders} value={orderFilter} onChange={value=>{setOrderFilter(value);setOpenOrderId(null);}}/>
        {orders.length===0?<p>데모 예약이 없습니다.</p>:visibleOrders.length===0?<p className="order-filter-empty">선택한 상태의 데모 예약이 없습니다.</p>:visibleOrders.map(order=><div className="order-list-item" key={order.id}>
          <article><div><strong>{order.ad_id} · {money(order.amount)} USDC</strong><p>예약 ID {order.id.slice(0,8)} · {orderStateLabel[order.state]||order.state}</p>{(order.state==='RESERVED'||order.state==='ACCEPTED')&&<p>{order.state==='RESERVED'?'응답 기한':'수락 후 종료 기한'} {new Date((order.state==='RESERVED'?order.response_due_at:order.expires_at)||order.expires_at).toLocaleString('ko-KR')}</p>}</div><div className="owned-actions">{(order.state==='RESERVED'||order.state==='ACCEPTED')&&<button onClick={()=>void cancel(order.id)}>예약 취소</button>}<button aria-expanded={openOrderId===order.id} onClick={()=>void toggleOrderHistory(order.id)}>상태 이력</button></div></article>
          {openOrderId===order.id&&<OrderTimeline events={orderEvents} wallet={wallet}/>}
          <OrderConversation id={order.id} wallet={wallet}/><OrderSafety id={order.id} onAdsChanged={refreshAds}/>
          {order.state==='ACCEPTED'&&chainEligible(order.terms_json)||['CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED','SETTLED','REFUNDED','SIGNATURE_EXPIRED'].includes(order.state)?<ChainOrderPanel id={order.id} wallet={wallet} role="taker" onChanged={async()=>{await refreshOrders();await refreshAds();}} onNotice={setNotice}/>:null}
        </div>)}
      </section>}
      <section id="how" className="how"><div><span className="eyebrow">HOW IT WILL WORK</span><h2>거래는 간단하게.<br/>과정은 투명하게.</h2><p>출시 버전에서 제공할 거래 흐름입니다.</p></div><article><span className="step">01</span><h3>조건 비교하기</h3><p>자산, 가격과 거래 한도를 확인하세요.</p></article><article><span className="step">02</span><h3>지갑에서 예치하기</h3><p>약정 조건을 확인하고<br/>에스크로 계약에 자산을 예치합니다.</p></article><article><span className="step">03</span><h3>양측 자산 교환하기</h3><p>양측 예치가 확인되면<br/>계약이 정해진 조건으로 정산합니다.</p></article></section>
      <footer><a className="logo" href="/">peer.</a><p>Crypto connects people.</p><span>Phase 0 · UX Prototype</span></footer>
    </main>
    {notice && <div className="toast" role="status">{notice}<button aria-label="알림 닫기" onClick={()=>setNotice('')}>×</button></div>}
    <dialog ref={dialog} onCancel={()=>setSelected(null)} onClick={e=>{if(e.target===e.currentTarget)setSelected(null);}} aria-labelledby="order-title">{selected && <div className="order"><button className="close" aria-label="상세 닫기" onClick={()=>setSelected(null)}>×</button><span className="eyebrow">TRADE PREVIEW</span><h2 id="order-title">{selected.asset} {side==='buy'?'구매':'판매'} 조건 확인</h2><p className="modal-sub">{selected.maker} · 데모 광고{selected.expiresAt?` · 만료 ${new Date(selected.expiresAt).toLocaleString('ko-KR')}`:''}</p><label>거래 기준 금액 (USDC)<input inputMode="decimal" value={orderAmount} onChange={e=>setOrderAmount(e.target.value)} aria-describedby="quote-error"/></label><p id="quote-error" className="error" role="status">{error}</p><dl><div><dt>고정 단가</dt><dd>{money(selected.price)} USDC</dd></div><div><dt>{side==='buy'?'예상 수취':'예상 지급'}</dt><dd>{estimate?.assetAmount ?? '—'} {selected.asset}</dd></div><div><dt>예시 수수료 (0.1%)</dt><dd>{estimate?.fee ?? '—'} USDC</dd></div><div className="total"><dt>{side==='buy'?'총 지급':'수수료 차감 수취'}</dt><dd>{(side==='buy'?estimate?.total:estimate?.proceeds) ?? '—'} USDC</dd></div></dl><div className="disclosure">로그인 후 데모 예약을 만들 수 있습니다. 광고주 응답 기한은 {selected.minutes}분입니다. {selected.makerAddress?'로컬 Anvil이 설정된 개발 환경에서만 테스트 토큰 예치·정산 흐름을 시험할 수 있습니다.':'이 예시 광고에는 연결된 광고주 지갑이 없어 수락 단계가 없습니다.'} 가격과 수수료는 예시입니다.</div><button className="primary" disabled={!estimate||busy} onClick={()=>void reserve()}>{wallet?'데모 예약 요청':'예약하려면 지갑 로그인'}</button></div>}</dialog>
  </>;
}
