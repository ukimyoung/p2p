'use client';
import { FormEvent, useEffect, useState } from 'react';

type Report={id:string;reason:string;details:string;status:string;created_at:number;reviewed_at?:number|null};
type Safety={target:string;blocked:boolean;report:Report|null;reportable:boolean};
const reasons:Record<string,string>={SPAM:'스팸',FRAUD:'사기 의심',IMPERSONATION:'신원 사칭',OTHER:'기타'};
const reviewLabels:Record<string,string>={PENDING:'검토 대기',CONFIRMED:'확인됨',DISMISSED:'기각'};

export default function OrderSafety({id,onAdsChanged}:{id:string;onAdsChanged:()=>Promise<void>}) {
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
  return <section className="order-safety" aria-label="주문 신고와 차단"><button className="safety-toggle" onClick={()=>setOpen(value=>!value)}>{open?'신고·차단 닫기':'신고·차단'}</button>{open&&<div className="safety-content">
    {error&&<p className="error" role="alert">{error}</p>}
    {unavailable?<p>연결된 상대방 지갑이 없는 예시 주문입니다.</p>:!safety?<p>상태를 불러오는 중입니다.</p>:<>
      <p>상대방 {safety.target.slice(0,6)}…{safety.target.slice(-4)}</p>
      <p>차단하면 서로의 새 광고 예약을 막습니다. 기존 주문의 대화·상태 조회·자산 회수는 유지됩니다.</p>
      <button disabled={busy} onClick={()=>void toggleBlock()}>{safety.blocked?'차단 해제':'상대방 차단'}</button>
      {safety.report?<p role="status">신고 접수됨 · {reviewLabels[safety.report.status]||safety.report.status} · {reasons[safety.report.reason]||safety.report.reason} · {new Date(safety.report.created_at).toLocaleString('ko-KR')}</p>:safety.reportable?<form onSubmit={event=>void report(event)}><label>신고 사유<select value={reason} onChange={event=>setReason(event.target.value)}>{Object.entries(reasons).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label>신고 내용<textarea value={details} minLength={10} maxLength={1000} rows={3} onChange={event=>setDetails(event.target.value)} placeholder="구체적인 상황을 10자 이상 적어주세요"/></label><button type="submit" disabled={busy||details.trim().length<10}>신고 접수</button></form>:<p>주문 종료 후 30일이 지나 신고 접수가 마감되었습니다.</p>}
      <p className="safety-note">개발 프리뷰는 신고 심사 결과를 표시하고 주문 종료 180일 후 삭제합니다. 심사 결과로 자동 제재하지 않습니다.</p>
    </>}
  </div>}</section>;
}
