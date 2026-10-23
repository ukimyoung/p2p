'use client';
import { FormEvent, useEffect, useState } from 'react';
import { orderStateLabel } from '../lib/market';

type Item={kind:'state';id:string;at:number;actor:string;state:string}|{kind:'message';id:string;at:number;actor:string;body:string};
type Conversation={items:Item[];writable:boolean;hasCounterparty:boolean};

export default function OrderConversation({id,wallet}:{id:string;wallet:string}) {
  const [open,setOpen]=useState(false);
  const [conversation,setConversation]=useState<Conversation|null>(null);
  const [draft,setDraft]=useState('');
  const [clientId,setClientId]=useState<string|null>(null);
  const [sending,setSending]=useState(false);
  const [error,setError]=useState('');
  const path=`/api/v1/orders/${id}/messages`;
  async function load() {
    const response=await fetch(path,{cache:'no-store'});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'대화를 불러오지 못했습니다.');
    setConversation(data as Conversation);
  }
  useEffect(()=>{
    if(!open)return;
    let active=true;
    const refresh=()=>{void fetch(path,{cache:'no-store'}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error||'대화를 불러오지 못했습니다.');if(active){setConversation(data as Conversation);setError('');}}).catch(reason=>{if(active)setError((reason as Error).message);});};
    refresh();
    const timer=setInterval(refresh,3000);
    return()=>{active=false;clearInterval(timer);};
  },[open,path]);
  async function send(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(sending||!draft.trim()||!conversation?.writable)return;
    const requestId=clientId||crypto.randomUUID();
    setClientId(requestId);setSending(true);setError('');
    try {
      const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:draft,clientId:requestId})});
      const data=await response.json();
      if(!response.ok)throw new Error(data.error||'메시지를 보내지 못했습니다.');
      setDraft('');setClientId(null);await load();
    } catch(reason) {setError((reason as Error).message);} finally {setSending(false);}
  }
  return <section className="order-conversation" aria-label="주문 대화"><button className="conversation-toggle" onClick={()=>setOpen(value=>!value)}>{open?'대화 닫기':'대화 보기'}</button>{open&&<div className="conversation-content">
    <p className="conversation-note">주문 참가자만 볼 수 있는 데모 대화입니다. 메시지는 로컬 SQLite에 저장되고 주문 종료 30일 후 삭제됩니다. 개인정보·시드 문구를 입력하지 마세요.</p>
    {error&&<p className="error" role="alert">{error}</p>}
    {!conversation?<p>대화를 불러오는 중입니다.</p>:<>
      <ol className="conversation-items" role="log" aria-live="polite">{conversation.items.map(item=><li key={item.id} className={item.kind==='state'?'conversation-state':item.actor.toLowerCase()===wallet.toLowerCase()?'conversation-self':'conversation-other'}>
        <span>{item.kind==='state'?'시스템':item.actor.toLowerCase()===wallet.toLowerCase()?'나':'상대방'} · {new Date(item.at).toLocaleString('ko-KR')}</span>
        <p>{item.kind==='state'?`주문 상태: ${orderStateLabel[item.state]||item.state}`:item.body}</p>
      </li>)}</ol>
      {conversation.writable?<form onSubmit={event=>void send(event)}><label>메시지<textarea value={draft} maxLength={1000} rows={3} onChange={event=>{setDraft(event.target.value);setClientId(null);}} placeholder="거래 조건과 진행 상황을 확인하세요"/></label><div><small>{draft.length}/1000 · 2초 간격</small><button type="submit" disabled={sending||!draft.trim()}>메시지 보내기</button></div></form>:<p className="conversation-note">{conversation.hasCounterparty?'종료된 주문은 읽기만 가능합니다.':'이 예시 주문에는 연결된 광고주 지갑이 없습니다.'}</p>}
    </>}
  </div>}</section>;
}
