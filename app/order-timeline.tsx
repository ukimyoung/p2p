'use client';
import {stateName, type Language} from '../lib/i18n';
import {useLanguage} from './language-provider';

export type OrderEvent={state:string;actor:string;occurred_at:number};

function actorLabel(actor:string,userId:string,language:Language) {
  if(actor.toLowerCase()===userId.toLowerCase())return language==='ko'?'나':'Me';
  if(actor==='system'||actor==='migration')return language==='ko'?'시스템':'System';
  return language==='ko'?'상대방':'Counterparty';
}

export default function OrderTimeline({events,wallet}:{events:OrderEvent[];wallet:string}) {
  const {language,locale,t}=useLanguage();
  return <div className="order-timeline"><h4>{t('거래 상태 타임라인','Order timeline')}</h4><ol className="order-history">
    {events.map((event,index)=><li key={index}><strong>{stateName(event.state,language)}</strong><span>{actorLabel(event.actor,wallet,language)} · <time dateTime={new Date(event.occurred_at).toISOString()}>{new Date(event.occurred_at).toLocaleString(locale)}</time></span></li>)}
  </ol></div>;
}
