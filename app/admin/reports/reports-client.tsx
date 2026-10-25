'use client';
import { useEffect, useState } from 'react';
import { LanguageSelect, useLanguage } from '../../language-provider';

type Status='PENDING'|'CONFIRMED'|'DISMISSED';
type Summary={id:string;order_id:string;reporter:string;reported:string;reason:string;status:Status;created_at:number;reviewed_at:number|null;order_state:string};
type Report=Summary&{details:string;reviewed_by:string|null;review_note:string|null};
type Detail={report:Report;order:{id:string;state:string;created_at:number;amount:string;asset_amount:string;price:string;taker:string;maker_address:string|null};messages:{id:number;sender:string;body:string;created_at:number}[];events:{state:string;actor:string;occurred_at:number}[]};
const labels:Record<Status,string>={PENDING:'검토 대기',CONFIRMED:'확인됨',DISMISSED:'기각'};
const reasons:Record<string,string>={SPAM:'스팸',FRAUD:'사기 의심',IMPERSONATION:'신원 사칭',OTHER:'기타'};


export default function AdminReports() {
  const {t,language,locale}=useLanguage();
  const date=(value:number|null)=>value?new Date(value).toLocaleString(locale):'—';
  const status=(value:Status)=>language==='ko'?labels[value]:({PENDING:'Pending',CONFIRMED:'Confirmed',DISMISSED:'Dismissed'}[value]);
  const reason=(value:string)=>language==='ko'?(reasons[value]||value):({SPAM:'Spam',FRAUD:'Suspected fraud',IMPERSONATION:'Impersonation',OTHER:'Other'}[value]||value);
  const [filter,setFilter]=useState<Status|'ALL'>('PENDING');
  const [reports,setReports]=useState<Summary[]>([]);
  const [hasMore,setHasMore]=useState(false);
  const [offset,setOffset]=useState(0);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [note,setNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function read(path:string) {
    const response=await fetch(path,{cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'신고 정보를 불러오지 못했습니다.');
    return data;
  }
  async function loadList(status:Status|'ALL',next=0) {
    try {
      const data=await read(`/api/v1/admin/reports?status=${status}&offset=${next}`);
      setReports(previous=>next?[...previous,...data.reports]:data.reports);
      setOffset(data.nextOffset);setHasMore(data.hasMore);setError('');
    } catch(cause) {setError((cause as Error).message);}
  }
  async function openReport(id:string) {
    try {setDetail(await read(`/api/v1/admin/reports/${id}`));setNote('');setError('');}
    catch(cause) {setError((cause as Error).message);}
  }
  useEffect(()=>{void loadList(filter);},[filter]);
  async function review(decision:'CONFIRMED'|'DISMISSED') {
    if(!detail||busy||note.trim().length<10)return;
    setBusy(true);setError('');
    try {
      const response=await fetch(`/api/v1/admin/reports/${detail.report.id}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,note})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||'심사 결과를 저장하지 못했습니다.');
      await openReport(detail.report.id);
      await loadList(filter);
    } catch(cause) {setError((cause as Error).message);} finally {setBusy(false);}
  }
  return <main className="admin-reports">
    <header><a href="/">{t('← 마켓으로','← Back to market')}</a><LanguageSelect/><div><p>PEER OPERATIONS</p><h1>{t('신고 검토','Review reports')}</h1></div></header>
    <p className="admin-intro">{t('운영자 계정으로 접수된 신고와 주문 기록을 확인합니다. 결과를 기록해도 계정 차단이나 자산 이동은 실행되지 않습니다.','Review reports and order records. Reviews do not block accounts or transfer assets.')}</p>
    {error&&<p role="alert" className="admin-error">{error}</p>}
    <div className="admin-columns"><section aria-label="신고 목록">
      <div className="admin-section-heading"><h2>{t('신고 목록','Reports')}</h2><label>{t('상태','Status')} <select value={filter} onChange={event=>{setFilter(event.target.value as Status|'ALL');setDetail(null);}}><option value="PENDING">{t('검토 대기','Pending')}</option><option value="CONFIRMED">{t('확인됨','Confirmed')}</option><option value="DISMISSED">{t('기각','Dismissed')}</option><option value="ALL">{t('전체','All')}</option></select></label></div>
      {reports.length===0?<p>{t('해당 상태의 신고가 없습니다.','No reports with this status.')}</p>:<ul className="admin-list">{reports.map(report=><li key={report.id}><button type="button" onClick={()=>void openReport(report.id)} aria-pressed={detail?.report.id===report.id}><strong>{reason(report.reason)} · {status(report.status)}</strong><span>{t('주문','Order')} {report.order_id.slice(0,8)} · {date(report.created_at)}</span><small>{t('신고자','Reporter')} {report.reporter}</small></button></li>)}</ul>}
      {hasMore&&<button className="admin-more" onClick={()=>void loadList(filter,offset)}>{t('더 보기','Load more')}</button>}
    </section><section aria-label="신고 상세" className="admin-detail">
      {!detail?<p>{t('목록에서 신고를 선택하세요.','Select a report from the list.')}</p>:<>
        <h2>{reason(detail.report.reason)} · {status(detail.report.status)}</h2>
        <dl><dt>{t('신고 접수','Submitted')}</dt><dd>{date(detail.report.created_at)}</dd><dt>{t('주문','Order')}</dt><dd>{detail.order.id} · {detail.order.state}</dd><dt>{t('신고자','Reporter')}</dt><dd>{detail.report.reporter}</dd><dt>{t('신고 대상','Reported user')}</dt><dd>{detail.report.reported}</dd><dt>{t('주문 금액','Order amount')}</dt><dd>{detail.order.amount} USDC · 기준 가격 {detail.order.price}</dd><dt>{t('신고 내용','Report details')}</dt><dd className="admin-body">{detail.report.details}</dd></dl>
        {detail.report.status==='PENDING'?<div className="admin-review"><label>{t('처리 메모','Review note')}<textarea value={note} onChange={event=>setNote(event.target.value)} minLength={10} maxLength={500} rows={4} placeholder={t('판단 근거를 10~500자로 기록하세요','Write a reason in 10–500 characters')}/></label><div><button disabled={busy||note.trim().length<10} onClick={()=>void review('CONFIRMED')}>{t('신고 확인','Confirm report')}</button><button disabled={busy||note.trim().length<10} onClick={()=>void review('DISMISSED')}>{t('신고 기각','Dismiss report')}</button></div></div>:<div className="admin-review"><p>{t('처리','Reviewed')} {date(detail.report.reviewed_at)} · {detail.report.reviewed_by}</p><p className="admin-body">{detail.report.review_note}</p></div>}
        <h3>{t('주문 상태 이력','Order history')}</h3><ol className="admin-evidence">{detail.events.map((event,index)=><li key={index}>{date(event.occurred_at)} · {event.state} · {event.actor}</li>)}</ol>
        <h3>{t('주문 대화','Order chat')}</h3>{detail.messages.length?<ol className="admin-evidence">{detail.messages.map(message=><li key={message.id}><strong>{message.sender} · {date(message.created_at)}</strong><p className="admin-body">{message.body}</p></li>)}</ol>:<p>{t('보존 중인 대화가 없습니다.','No retained chat messages.')}</p>}
      </>}
    </section></div>
  </main>;
}
