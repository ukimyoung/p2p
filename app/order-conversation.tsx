'use client';
import { FormEvent, useEffect, useState } from 'react';
import { stateName } from '../lib/i18n';
import { useLanguage } from './language-provider';

type Item={kind:'state';id:string;at:number;actor:string;state:string}|{kind:'message';id:string;at:number;actor:string;body:string};
type Conversation={items:Item[];writable:boolean;hasCounterparty:boolean};

export default function OrderConversation({id,wallet}:{id:string;wallet:string}) {
  const {t,language,locale}=useLanguage();
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
  return <section className="order-conversation" aria-label={t('주문 대화','Order conversation')}><button className="conversation-toggle" onClick={()=>setOpen(value=>!value)}>{open?t('대화 닫기','Close chat'):t('대화 보기','View chat')}</button>{open&&<div className="conversation-content">
    <p className="conversation-note">{t('주문 참가자만 볼 수 있는 데모 대화입니다. 주문 종료 30일 후 삭제됩니다. 개인정보를 입력하지 마세요.','Only order participants can see this demo chat. Messages are deleted 30 days after the order closes. Do not share personal information.')}</p>
    {error&&<p className="error" role="alert">{error}</p>}
    {!conversation?<p>{t('대화를 불러오는 중입니다.','Loading chat.')}</p>:<>
      <ol className="conversation-items" role="log" aria-live="polite">{conversation.items.map(item=><li key={item.id} className={item.kind==='state'?'conversation-state':item.actor.toLowerCase()===wallet.toLowerCase()?'conversation-self':'conversation-other'}>
        <span>{item.kind==='state'?t('시스템','System'):item.actor.toLowerCase()===wallet.toLowerCase()?t('나','Me'):t('상대방','Counterparty')} · {new Date(item.at).toLocaleString(locale)}</span>
        <p>{item.kind==='state'?`${t('주문 상태','Order status')}: ${stateName(item.state,language)}`:item.body}</p>
      </li>)}</ol>
      {conversation.writable?<form onSubmit={event=>void send(event)}><label>{t('메시지','Message')}<textarea value={draft} maxLength={1000} rows={3} onChange={event=>{setDraft(event.target.value);setClientId(null);}} placeholder={t('거래 조건과 진행 상황을 확인하세요','Confirm trade terms and progress')}/></label><div><small>{draft.length}/1000 · {t('2초 간격','2-second interval')}</small><button type="submit" disabled={sending||!draft.trim()}>{t('메시지 보내기','Send message')}</button></div></form>:<p className="conversation-note">{conversation.hasCounterparty?t('종료된 주문은 읽기만 가능합니다.','Closed orders are read-only.'):t('이 예시 주문에는 연결된 광고주 계정이 없습니다.','This sample order has no advertiser account.')}</p>}
    </>}
  </div>}</section>;
}
