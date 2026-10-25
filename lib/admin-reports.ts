import { db, InputError, pruneSensitiveOrderData, transaction } from './store';

type Decision='CONFIRMED'|'DISMISSED';
type ReportRow={id:string;order_id:string;reporter:string;reported:string;reason:string;details:string;status:string;created_at:number;reviewed_at:number|null;reviewed_by:string|null;review_note:string|null};

export function isReportAdmin(address:string|undefined) {
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const entries=(process.env.P2P_ADMIN_USER_IDS||'').split(',').map(value=>value.trim()).filter(Boolean);
  return !!address&&uuid.test(address)&&entries.length>0&&entries.every(value=>uuid.test(value))&&entries.some(value=>value.toLowerCase()===address.toLowerCase());
}
function requireReportAdmin(address:string) {
  if(!isReportAdmin(address)) throw new InputError('운영자 권한이 없습니다.',403);
}

export function listAdminReports(address:string,status:string|null='PENDING',offset:string|null='0') {
  requireReportAdmin(address);
  if(!['PENDING','CONFIRMED','DISMISSED','ALL'].includes(status||'')) throw new InputError('신고 상태 필터를 확인하세요.');
  if(!offset||!/^\d+$/.test(offset)||Number(offset)>10_000) throw new InputError('목록 위치를 확인하세요.');
  pruneSensitiveOrderData();
  const filter=status==='ALL'?'':'WHERE r.status=?';
  const statement=db().prepare(`SELECT r.id,r.order_id,r.reporter,r.reported,r.reason,r.status,r.created_at,r.reviewed_at,o.state AS order_state FROM order_reports r JOIN orders o ON o.id=r.order_id ${filter} ORDER BY r.created_at ASC,r.id ASC LIMIT 51 OFFSET ?`);
  const rows=(status==='ALL'?statement.all(Number(offset)):statement.all(status,Number(offset))) as Record<string,unknown>[];
  return {reports:rows.slice(0,50),hasMore:rows.length>50,nextOffset:Number(offset)+50};
}

export function getAdminReport(address:string,id:string) {
  requireReportAdmin(address);
  pruneSensitiveOrderData();
  const database=db();
  const report=database.prepare('SELECT * FROM order_reports WHERE id=?').get(id) as ReportRow|undefined;
  if(!report) throw new InputError('신고를 찾을 수 없습니다.',404);
  const order=database.prepare('SELECT o.id,o.state,o.created_at,o.amount,o.asset_amount,o.price,o.taker,a.maker_address FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=?').get(report.order_id);
  const messages=database.prepare('SELECT id,sender,body,created_at FROM order_messages WHERE order_id=? ORDER BY id').all(report.order_id);
  const events=database.prepare('SELECT state,actor,occurred_at FROM order_events WHERE order_id=? ORDER BY id').all(report.order_id);
  return {report,order,messages,events};
}

export function reviewAdminReport(address:string,id:string,decision:unknown,note:unknown,now=Date.now()) {
  requireReportAdmin(address);
  if(decision!=='CONFIRMED'&&decision!=='DISMISSED') throw new InputError('심사 결과를 선택하세요.');
  if(typeof note!=='string'||note.trim().length<10||note.trim().length>500) throw new InputError('처리 메모는 10~500자로 입력하세요.');
  pruneSensitiveOrderData(now);
  return transaction(database=>{
    const report=database.prepare('SELECT * FROM order_reports WHERE id=?').get(id) as ReportRow|undefined;
    if(!report) throw new InputError('신고를 찾을 수 없습니다.',404);
    if(report.status!=='PENDING') {
      if(report.status===decision&&report.reviewed_by===address.toLowerCase()&&report.review_note===note.trim()) return report;
      throw new InputError('이미 처리된 신고입니다.',409);
    }
    database.prepare("UPDATE order_reports SET status=?,reviewed_at=?,reviewed_by=?,review_note=? WHERE id=? AND status='PENDING'").run(decision,now,address.toLowerCase(),note.trim(),id);
    return database.prepare('SELECT * FROM order_reports WHERE id=?').get(id) as ReportRow;
  });
}
