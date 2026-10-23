import {orderStateLabel} from '../lib/market';

export type OrderEvent={state:string;actor:string;occurred_at:number};

function actorLabel(actor:string,wallet:string) {
  if(actor.toLowerCase()===wallet.toLowerCase())return '나';
  if(actor==='chain')return '체인 확인';
  if(actor==='chain-reorg')return '체인 재구성';
  if(actor==='system'||actor==='migration')return '시스템';
  return '상대방';
}

export default function OrderTimeline({events,wallet}:{events:OrderEvent[];wallet:string}) {
  return <div className="order-timeline"><h4>거래 상태 타임라인</h4><ol className="order-history">
    {events.map((event,index)=><li key={index}><strong>{orderStateLabel[event.state]||event.state}</strong><span>{actorLabel(event.actor,wallet)} · <time dateTime={new Date(event.occurred_at).toISOString()}>{new Date(event.occurred_at).toLocaleString('ko-KR')}</time></span></li>)}
  </ol></div>;
}
