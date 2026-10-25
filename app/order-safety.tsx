'use client';
import { FormEvent, useEffect, useState } from 'react';
import { useLanguage } from './language-provider';

type Report={id:string;reason:string;details:string;status:string;created_at:number;reviewed_at?:number|null};
type Safety={target:string;blocked:boolean;report:Report|null;reportable:boolean};
const reasons:Record<string,string>={SPAM:'스팸',FRAUD:'사기 의심',IMPERSONATION:'신원 사칭',OTHER:'기타'};
const reviewLabels:Record<string,string>={PENDING:'검토 대기',CONFIRMED:'확인됨',DISMISSED:'기각'};

export default function OrderSafety({id,onAdsChanged}:{id:string;onAdsChanged:()=>Promise<void>}) {
  const {t,language,locale}=useLanguage();
  const [open,setOpen]=useState(false);
  const [safety,setSafety]=useState<Safety|null>(null);
  const [unavailable,setUnavailable]=useState(false);
  const [reason,setReason]=useState('SPAM');
  const [details,setDetails]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const path=`/api/v1/orders/${id}/safety`;
  useEffect(()=>{
    if(!open)return;
    let active=true;
    void fetch(path,{cache:'no-store'}).then(async response=>{
      const data=await response.json();
      if(response.status===409){if(active)setUnavailable(true);return;}
      if(!response.ok)throw new Error(data.error||'신고·차단 상태를 불러오지 못했습니다.');
      if(active){setSafety(data as Safety);setUnavailable(false);setError('');}
    }).catch(cause=>{if(active)setError((cause as Error).message);});
    return()=>{active=false;};
  },[open,path]);
  async function post(body:unknown) {
    const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error||'요청을 완료하지 못했습니다.');
    return data;
  }
  async function toggleBlock() {
    if(!safety||busy)return;
    setBusy(true);setError('');
    try {
      const data=await post({action:safety.blocked?'unblock':'block'});
      setSafety(current=>current?{...current,blocked:data.blocked}:current);
      await onAdsChanged();
    } catch(cause) {setError((cause as Error).message);} finally {setBusy(false);}
  }
  async function report(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(!safety||safety.report||busy)return;
    setBusy(true);setError('');
    try {
      const data=await post({action:'report',reason,details});
      setSafety(current=>current?{...current,report:data.report}:current);
    } catch(cause) {setError((cause as Error).message);} finally {setBusy(false);}
  }
  return <section className="order-safety" aria-label={t('주문 신고와 차단','Report and block')}><button className="safety-toggle" onClick={()=>setOpen(value=>!value)}>{open?t('신고·차단 닫기','Close report panel'):t('신고·차단','Report / Block')}</button>{open&&<div className="safety-content">
    {error&&<p className="error" role="alert">{error}</p>}
    {unavailable?<p>{t('연결된 상대방 계정이 없는 예시 주문입니다.','This sample order has no counterparty account.')}</p>:!safety?<p>{t('상태를 불러오는 중입니다.','Loading status.')}</p>:<>
      <p>{t('상대방','Counterparty')} {safety.target.slice(0,8)}</p>
      <p>{t('차단하면 서로의 새 광고 예약을 막습니다. 기존 주문의 대화와 상태 조회는 유지됩니다.','Blocking prevents new reservations between you. Existing order chats and status remain available.')}</p>
      <button disabled={busy} onClick={()=>void toggleBlock()}>{safety.blocked?t('차단 해제','Unblock'):t('상대방 차단','Block user')}</button>
      {safety.report?<p role="status">{t('신고 접수됨','Report submitted')} · {language==='ko'?(reviewLabels[safety.report.status]||safety.report.status):({PENDING:'Pending',CONFIRMED:'Confirmed',DISMISSED:'Dismissed'}[safety.report.status]||safety.report.status)} · {language==='ko'?(reasons[safety.report.reason]||safety.report.reason):({SPAM:'Spam',FRAUD:'Suspected fraud',IMPERSONATION:'Impersonation',OTHER:'Other'}[safety.report.reason]||safety.report.reason)} · {new Date(safety.report.created_at).toLocaleString(locale)}</p>:safety.reportable?<form onSubmit={event=>void report(event)}><label>{t('신고 사유','Reason')}<select value={reason} onChange={event=>setReason(event.target.value)}>{Object.entries(reasons).map(([value,label])=><option key={value} value={value}>{language==='ko'?label:({SPAM:'Spam',FRAUD:'Suspected fraud',IMPERSONATION:'Impersonation',OTHER:'Other'}[value])}</option>)}</select></label><label>{t('신고 내용','Details')}<textarea value={details} minLength={10} maxLength={1000} rows={3} onChange={event=>setDetails(event.target.value)} placeholder={t('구체적인 상황을 10자 이상 적어주세요','Describe the situation in at least 10 characters')}/></label><button type="submit" disabled={busy||details.trim().length<10}>{t('신고 접수','Submit report')}</button></form>:<p>{t('신고 접수 기간이 지났습니다.','The reporting window has closed.')}</p>}
      <p className="safety-note">{t('신고는 주문 종료 180일 후 삭제합니다. 심사 결과로 자동 제재하지 않습니다.','Reports are deleted 180 days after an order closes. Reviews do not automatically sanction accounts.')}</p>
    </>}
  </div>}</section>;
}
