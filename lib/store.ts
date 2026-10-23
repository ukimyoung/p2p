import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Ad, ads as fixtures, quote, units, formatUnits } from './market';

export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const databasePath = () => process.env.P2P_DB_PATH || join(process.cwd(), '.data', 'p2p.sqlite');
let database: DatabaseSync | undefined;
export function db() {
  if (database) return database;
  const path = databasePath();
  mkdirSync(dirname(path), {recursive:true});
  const instance = new DatabaseSync(path);
  instance.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS ads (id TEXT PRIMARY KEY, maker TEXT NOT NULL, maker_address TEXT, initials TEXT NOT NULL, trades INTEGER NOT NULL, completion REAL NOT NULL, side TEXT NOT NULL, asset TEXT NOT NULL, price TEXT NOT NULL, available_units TEXT NOT NULL, total_units TEXT, min TEXT NOT NULL, max TEXT NOT NULL, minutes INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ACTIVE', expires_at INTEGER, created_at INTEGER, created_order INTEGER);
    CREATE TABLE IF NOT EXISTS challenges (nonce_hash TEXT PRIMARY KEY, address TEXT NOT NULL, message TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, address TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, taker TEXT NOT NULL, idempotency_key TEXT NOT NULL, amount TEXT NOT NULL, asset_amount TEXT NOT NULL, fee TEXT NOT NULL, price TEXT NOT NULL, terms_hash TEXT NOT NULL, terms_json TEXT, ad_version INTEGER NOT NULL, created_at INTEGER NOT NULL, response_due_at INTEGER, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('RESERVED','ACCEPTED','DECLINED','CANCELLED','EXPIRED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED','SETTLED','REFUNDED','SIGNATURE_EXPIRED')), UNIQUE(taker,idempotency_key));
    CREATE TABLE IF NOT EXISTS chain_orders (order_id TEXT PRIMARY KEY, onchain_id TEXT NOT NULL UNIQUE, chain_id INTEGER NOT NULL, contract TEXT NOT NULL, terms_json TEXT NOT NULL, maker_signature TEXT, taker_signature TEXT, open_tx TEXT, maker_tx TEXT, taker_tx TEXT, final_tx TEXT, state TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS chain_events (chain_id INTEGER NOT NULL, tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, event_name TEXT NOT NULL, order_id TEXT NOT NULL, data_json TEXT NOT NULL, PRIMARY KEY(chain_id,tx_hash,log_index));
    CREATE INDEX IF NOT EXISTS chain_events_order ON chain_events(order_id,block_number,log_index);
    CREATE TABLE IF NOT EXISTS chain_blocks (chain_id INTEGER NOT NULL, block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, PRIMARY KEY(chain_id,block_number));
    CREATE TABLE IF NOT EXISTS chain_sync (chain_id INTEGER PRIMARY KEY, contract TEXT NOT NULL, start_block INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS order_events (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, state TEXT NOT NULL, actor TEXT NOT NULL, occurred_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS order_events_order ON order_events(order_id,id);
    CREATE TABLE IF NOT EXISTS order_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, sender TEXT NOT NULL, client_id TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(order_id,sender,client_id));
    CREATE INDEX IF NOT EXISTS order_messages_order ON order_messages(order_id,id);
    CREATE TABLE IF NOT EXISTS user_blocks (blocker TEXT NOT NULL, blocked TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(blocker,blocked));
    CREATE TABLE IF NOT EXISTS order_reports (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, reporter TEXT NOT NULL, reported TEXT NOT NULL, reason TEXT NOT NULL, details TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING', created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by TEXT, review_note TEXT, UNIQUE(order_id,reporter));
    CREATE INDEX IF NOT EXISTS order_reports_order ON order_reports(order_id);
    CREATE INDEX IF NOT EXISTS order_reports_queue ON order_reports(status,created_at,id);
    CREATE INDEX IF NOT EXISTS orders_expiry ON orders(state,expires_at);`);
  const columns=instance.prepare('PRAGMA table_info(orders)').all() as {name:string}[];
  if(!columns.some(column=>column.name==='terms_json')) instance.exec('ALTER TABLE orders ADD COLUMN terms_json TEXT');
  if(!columns.some(column=>column.name==='response_due_at')) instance.exec('ALTER TABLE orders ADD COLUMN response_due_at INTEGER');
  const orderSchema=instance.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get() as {sql:string};
  if(!orderSchema.sql.includes("'SIGNATURE_EXPIRED'")) instance.exec(`BEGIN IMMEDIATE;
    ALTER TABLE orders RENAME TO orders_previous;
    CREATE TABLE orders (id TEXT PRIMARY KEY, ad_id TEXT NOT NULL, taker TEXT NOT NULL, idempotency_key TEXT NOT NULL, amount TEXT NOT NULL, asset_amount TEXT NOT NULL, fee TEXT NOT NULL, price TEXT NOT NULL, terms_hash TEXT NOT NULL, terms_json TEXT, ad_version INTEGER NOT NULL, created_at INTEGER NOT NULL, response_due_at INTEGER, expires_at INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('RESERVED','ACCEPTED','DECLINED','CANCELLED','EXPIRED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED','SETTLED','REFUNDED','SIGNATURE_EXPIRED')), UNIQUE(taker,idempotency_key));
    INSERT INTO orders SELECT id,ad_id,taker,idempotency_key,amount,asset_amount,fee,price,terms_hash,terms_json,ad_version,created_at,response_due_at,expires_at,state FROM orders_previous;
    DROP TABLE orders_previous;
    CREATE INDEX IF NOT EXISTS orders_expiry ON orders(state,expires_at);
    COMMIT;`);
  instance.prepare("INSERT INTO order_events (order_id,state,actor,occurred_at) SELECT id,state,'migration',? FROM orders WHERE NOT EXISTS (SELECT 1 FROM order_events WHERE order_id=orders.id)").run(Date.now());
  const adColumns=instance.prepare('PRAGMA table_info(ads)').all() as {name:string}[];
  if(!adColumns.some(column=>column.name==='maker_address')) instance.exec('ALTER TABLE ads ADD COLUMN maker_address TEXT');
  if(!adColumns.some(column=>column.name==='total_units')) instance.exec('ALTER TABLE ads ADD COLUMN total_units TEXT');
  if(!adColumns.some(column=>column.name==='expires_at')) instance.exec('ALTER TABLE ads ADD COLUMN expires_at INTEGER');
  if(!adColumns.some(column=>column.name==='created_at')) instance.exec('ALTER TABLE ads ADD COLUMN created_at INTEGER');
  if(!adColumns.some(column=>column.name==='created_order')) instance.exec('ALTER TABLE ads ADD COLUMN created_order INTEGER');
  instance.exec('UPDATE ads SET created_order=rowid WHERE created_order IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS ads_created_order ON ads(created_order)');
  const reportColumns=instance.prepare('PRAGMA table_info(order_reports)').all() as {name:string}[];
  if(!reportColumns.some(column=>column.name==='reviewed_at')) instance.exec('ALTER TABLE order_reports ADD COLUMN reviewed_at INTEGER');
  if(!reportColumns.some(column=>column.name==='reviewed_by')) instance.exec('ALTER TABLE order_reports ADD COLUMN reviewed_by TEXT');
  if(!reportColumns.some(column=>column.name==='review_note')) instance.exec('ALTER TABLE order_reports ADD COLUMN review_note TEXT');
  const insert = instance.prepare('INSERT OR IGNORE INTO ads (id,maker,initials,trades,completion,side,asset,price,available_units,min,max,minutes,created_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(created_order),0)+1 FROM ads))');
  for (const ad of fixtures) insert.run(ad.id,ad.maker,ad.initials,0,0,ad.side,ad.asset,ad.price,units(ad.available,ad.asset==='ETH'?18:8).toString(),ad.min,ad.max,ad.minutes);
  const missingTotals=instance.prepare('SELECT id,available_units FROM ads WHERE total_units IS NULL').all() as {id:string,available_units:string}[];
  for(const ad of missingTotals) {
    const reserved=instance.prepare("SELECT asset_amount FROM orders WHERE ad_id=? AND state IN ('RESERVED','ACCEPTED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED')").all(ad.id) as {asset_amount:string}[];
    const total=reserved.reduce((sum,order)=>sum+BigInt(order.asset_amount),BigInt(ad.available_units));
    instance.prepare('UPDATE ads SET total_units=? WHERE id=?').run(total.toString(),ad.id);
  }
  database = instance;
  return instance;
}
export function resetStoreForTests() { database?.close(); database = undefined; }
export function transaction<T>(work: (database: DatabaseSync) => T): T {
  const database = db();
  database.exec('BEGIN IMMEDIATE');
  try {const result = work(database); database.exec('COMMIT'); return result;}
  catch(error) {database.exec('ROLLBACK'); throw error;}
}
type AdRow = Omit<Ad,'available'|'createdAt'|'createdOrder'> & {trades:number,completion:number,available_units:string, total_units:string, maker_address:string|null, version:number, status:string, expires_at:number|null, created_at:number|null, created_order:number|null};
function publicAd(row: AdRow): Ad & {version:number, status:string} {
  const {available_units,total_units,maker_address,expires_at,created_at,created_order,trades,completion,...rest} = row;
  const decimals=row.asset==='ETH'?18:8;
  return {...rest, available:formatUnits(BigInt(available_units),decimals),total:formatUnits(BigInt(total_units),decimals),makerAddress:maker_address??undefined,expiresAt:expires_at??undefined,createdAt:created_at??undefined,createdOrder:created_order??undefined,demo:true};
}
export function getAds(viewer?:string) { expireReservations(); return (db().prepare("SELECT * FROM ads WHERE status='ACTIVE'").all() as unknown as AdRow[]).filter(row=>(!viewer||!row.maker_address||!blockedBetween(db(),viewer,row.maker_address))&&BigInt(row.available_units)*units(row.price)/10n**BigInt(row.asset==='ETH'?18:8)>=units(row.min)).map(publicAd); }
export function getAd(id:string) {expireReservations();const row=db().prepare("SELECT * FROM ads WHERE id=? AND status='ACTIVE'").get(id) as AdRow|undefined; return row?publicAd(row):undefined;}
export function getMakerAds(address:string) {expireReservations();return (db().prepare('SELECT * FROM ads WHERE maker_address=? ORDER BY created_order DESC').all(address) as unknown as AdRow[]).map(publicAd);}
function expireReservationsIn(database:DatabaseSync,now:number) {
  database.prepare("UPDATE ads SET status='EXPIRED',version=version+1 WHERE status IN ('ACTIVE','PAUSED') AND expires_at IS NOT NULL AND expires_at<=?").run(now);
  const rows=database.prepare("SELECT id,ad_id,asset_amount FROM orders WHERE (state='RESERVED' AND COALESCE(response_due_at,expires_at)<=?) OR (state='ACCEPTED' AND expires_at<=?)").all(now,now) as {id:string,ad_id:string,asset_amount:string}[];
  for(const row of rows) {
    const ad=database.prepare('SELECT available_units FROM ads WHERE id=?').get(row.ad_id) as {available_units:string};
    database.prepare('UPDATE ads SET available_units=?, version=version+1 WHERE id=?').run((BigInt(ad.available_units)+BigInt(row.asset_amount)).toString(),row.ad_id);
    database.prepare("UPDATE orders SET state='EXPIRED' WHERE id=?").run(row.id);
    recordOrderEvent(database,row.id,'EXPIRED','system',now);
  }
}
export function expireReservations(now=Date.now()) {transaction(database=>expireReservationsIn(database,now));}
function recordOrderEvent(database:DatabaseSync,id:string,state:string,actor:string,now:number) {
  database.prepare('INSERT INTO order_events (order_id,state,actor,occurred_at) VALUES (?,?,?,?)').run(id,state,actor,now);
}
export class InputError extends Error {constructor(message:string,public status=400){super(message);}}
type AdTerms = {side:Ad['side'],asset:Ad['asset'],price:string,total:string,min:string,max:string,minutes:number,validHours:number};
function decimal(value:unknown,decimals:number,label:string) {
  if(typeof value!=='string'||!new RegExp(`^(0|[1-9]\\d{0,8})(\\.\\d{1,${decimals}})?$`).test(value)) throw new InputError(`${label} 형식을 확인하세요.`);
  const parsed=units(value,decimals);
  if(parsed===0n||parsed>units('100000000',decimals)) throw new InputError(`${label} 범위를 확인하세요.`);
  return {value:formatUnits(parsed,decimals),units:parsed};
}
function validateAdTerms(input:unknown):AdTerms & {totalUnits:bigint} {
  if(!input||typeof input!=='object'||Array.isArray(input)) throw new InputError('광고 조건을 확인하세요.');
  const body=input as Record<string,unknown>;
  if(body.side!=='buy'&&body.side!=='sell') throw new InputError('거래 방향을 확인하세요.');
  if(body.asset!=='ETH'&&body.asset!=='WBTC') throw new InputError('지원하지 않는 자산입니다.');
  const decimals=body.asset==='ETH'?18:8;
  const price=decimal(body.price,6,'단가');
  const total=decimal(body.total,decimals,'총 수량');
  const min=decimal(body.min,6,'최소 금액');
  const max=decimal(body.max,6,'최대 금액');
  if(total.units>units('1000000',decimals)||max.units<min.units||max.units>total.units*price.units/10n**BigInt(decimals)) throw new InputError('수량과 거래 한도가 일치하지 않습니다.');
  if(typeof body.minutes!=='number'||!Number.isInteger(body.minutes)||body.minutes<5||body.minutes>60) throw new InputError('응답 시간은 5~60분이어야 합니다.');
  if(typeof body.validHours!=='number'||!Number.isInteger(body.validHours)||body.validHours<1||body.validHours>168) throw new InputError('광고 유효기간은 1~168시간이어야 합니다.');
  return {side:body.side,asset:body.asset,price:price.value,total:total.value,min:min.value,max:max.value,minutes:body.minutes,validHours:body.validHours,totalUnits:total.units};
}
export function createAd(address:string,input:unknown) {
  const terms=validateAdTerms(input);
  const id=randomUUID();
  const maker=`${address.slice(0,6)}…${address.slice(-4)}`;
  const now=Date.now();
  db().prepare("INSERT INTO ads (id,maker,maker_address,initials,trades,completion,side,asset,price,available_units,total_units,min,max,minutes,version,status,created_at,created_order,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'ACTIVE',?,(SELECT COALESCE(MAX(created_order),0)+1 FROM ads),?)")
    .run(id,maker,address,'ME',0,0,terms.side,terms.asset,terms.price,terms.totalUnits.toString(),terms.totalUnits.toString(),terms.min,terms.max,terms.minutes,now,now+terms.validHours*60*60_000);
  return getAd(id)!;
}
export function updateAd(address:string,id:string,input:unknown,expectedVersion:unknown) {
  if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1) throw new InputError('광고 버전이 필요합니다.');
  expireReservations();
  return transaction(database=>{
    const row=database.prepare('SELECT * FROM ads WHERE id=? AND maker_address=?').get(id,address) as AdRow|undefined;
    if(!row) throw new InputError('내 광고를 찾을 수 없습니다.',404);
    if(row.status==='CLOSED'||row.status==='EXPIRED') throw new InputError('종료되거나 만료된 광고는 수정할 수 없습니다.',409);
    if(row.version!==expectedVersion) throw new InputError('광고가 변경되었습니다. 새로고침 후 다시 시도하세요.',409);
    if(!input||typeof input!=='object'||Array.isArray(input)) throw new InputError('광고 조건을 확인하세요.');
    const body=input as Record<string,unknown>;
    if((body.side!==undefined&&body.side!==row.side)||(body.asset!==undefined&&body.asset!==row.asset)) throw new InputError('자산과 거래 방향은 변경할 수 없습니다.',409);
    const terms=validateAdTerms({...body,side:row.side,asset:row.asset});
    const reserved=database.prepare("SELECT asset_amount FROM orders WHERE ad_id=? AND state IN ('RESERVED','ACCEPTED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED')").all(id) as {asset_amount:string}[];
    const reservedUnits=reserved.reduce((sum,order)=>sum+BigInt(order.asset_amount),0n);
    if(terms.totalUnits<reservedUnits) throw new InputError('예약된 수량보다 총 수량을 줄일 수 없습니다.',409);
    database.prepare('UPDATE ads SET price=?,total_units=?,available_units=?,min=?,max=?,minutes=?,expires_at=?,version=version+1 WHERE id=?')
      .run(terms.price,terms.totalUnits.toString(),(terms.totalUnits-reservedUnits).toString(),terms.min,terms.max,terms.minutes,Date.now()+terms.validHours*60*60_000,id);
    return publicAd(database.prepare('SELECT * FROM ads WHERE id=?').get(id) as unknown as AdRow);
  });
}
export function changeAdStatus(address:string,id:string,action:unknown,expectedVersion:unknown) {
  if(!Number.isSafeInteger(expectedVersion)||Number(expectedVersion)<1) throw new InputError('광고 버전이 필요합니다.');
  if(action!=='pause'&&action!=='resume'&&action!=='close') throw new InputError('광고 작업을 확인하세요.');
  expireReservations();
  return transaction(database=>{
    const row=database.prepare('SELECT * FROM ads WHERE id=? AND maker_address=?').get(id,address) as AdRow|undefined;
    if(!row) throw new InputError('내 광고를 찾을 수 없습니다.',404);
    if(row.version!==expectedVersion) throw new InputError('광고가 변경되었습니다. 새로고침 후 다시 시도하세요.',409);
    if(row.status==='CLOSED'||row.status==='EXPIRED'||(action==='pause'&&row.status!=='ACTIVE')||(action==='resume'&&row.status!=='PAUSED')) throw new InputError('현재 광고 상태에서 수행할 수 없습니다.',409);
    const next=action==='pause'?'PAUSED':action==='resume'?'ACTIVE':'CLOSED';
    database.prepare('UPDATE ads SET status=?,version=version+1 WHERE id=?').run(next,id);
    return publicAd(database.prepare('SELECT * FROM ads WHERE id=?').get(id) as unknown as AdRow);
  });
}
export function reserveOrder(address:string,adId:string,amount:string,key:string,now=Date.now()) {
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new InputError('Idempotency-Key가 필요합니다.');
  if (typeof adId!=='string'||typeof amount!=='string') throw new InputError('광고와 금액을 확인하세요.');
  expireReservations(now);
  return transaction(database=>{
    const old=database.prepare('SELECT * FROM orders WHERE taker=? AND idempotency_key=?').get(address,key) as Record<string,unknown>|undefined;
    if(old) {
      if(old.ad_id!==adId||old.amount!==amount) throw new InputError('같은 요청 키에 다른 조건을 사용할 수 없습니다.',409);
      return old;
    }
    const row=database.prepare("SELECT * FROM ads WHERE id=? AND status='ACTIVE'").get(adId) as AdRow|undefined;
    if(!row) throw new InputError('활성 광고를 찾을 수 없습니다.',404);
    if(row.maker_address===address) throw new InputError('자신의 광고는 예약할 수 없습니다.',403);
    if(row.maker_address&&blockedBetween(database,address,row.maker_address)) throw new InputError('차단된 상대방의 광고는 예약할 수 없습니다.',403);
    const ad=publicAd(row);
    let estimate:ReturnType<typeof quote>;
    try {estimate=quote(ad,amount);} catch(error) {const message=(error as Error).message;throw new InputError(message,message.includes('거래 가능 수량')?409:400);}
    const decimals=ad.asset==='ETH'?18:8;
    const assetUnits=units(estimate.assetAmount,decimals);
    if(assetUnits>BigInt(row.available_units)) throw new InputError('거래 가능 수량이 부족합니다.',409);
    const id=randomUUID();
    const responseDue=now+ad.minutes*60_000;
    const expires=responseDue;
    const terms={id,adId,adVersion:row.version,maker:ad.maker,makerAddress:row.maker_address,taker:address,side:ad.side,asset:ad.asset,price:ad.price,amount,assetAmount:estimate.assetAmount,fee:estimate.fee,responseDueAt:responseDue};
    database.prepare('UPDATE ads SET available_units=?,version=version+1 WHERE id=?').run((BigInt(row.available_units)-assetUnits).toString(),adId);
    database.prepare("INSERT INTO orders (id,ad_id,taker,idempotency_key,amount,asset_amount,fee,price,terms_hash,terms_json,ad_version,created_at,response_due_at,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'RESERVED')")
      .run(id,adId,address,key,amount,assetUnits.toString(),estimate.fee,ad.price,digest(JSON.stringify(terms)),JSON.stringify(terms),row.version,now,responseDue,expires);
    recordOrderEvent(database,id,'RESERVED',address,now);
    return database.prepare('SELECT * FROM orders WHERE id=?').get(id) as Record<string,unknown>;
  });
}
export function listOrders(address:string) {expireReservations(); return db().prepare('SELECT id,ad_id,amount,asset_amount,fee,price,terms_hash,terms_json,ad_version,created_at,response_due_at,expires_at,state FROM orders WHERE taker=? ORDER BY created_at DESC').all(address);}
export function listIncomingOrders(address:string) {expireReservations();return db().prepare('SELECT o.id,o.ad_id,o.taker,o.amount,o.asset_amount,o.fee,o.price,o.terms_hash,o.terms_json,o.ad_version,o.created_at,o.response_due_at,o.expires_at,o.state FROM orders o JOIN ads a ON a.id=o.ad_id WHERE a.maker_address=? ORDER BY o.created_at DESC').all(address);}
export function getOrderDetail(address:string,id:string) {
  expireReservations();
  const order=db().prepare('SELECT o.* FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND (o.taker=? OR a.maker_address=?)').get(id,address,address);
  if(!order) throw new InputError('주문을 찾을 수 없습니다.',404);
  const events=db().prepare('SELECT state,actor,occurred_at FROM order_events WHERE order_id=? ORDER BY id').all(id);
  return {order,events};
}
type ConversationOrder={state:string;maker_address:string|null};
type SafetyOrder={taker:string;maker_address:string|null};
const reportReasons=new Set(['SPAM','FRAUD','IMPERSONATION','OTHER']);
const closedStates=new Set(['DECLINED','CANCELLED','EXPIRED','SETTLED','REFUNDED','SIGNATURE_EXPIRED']);
export const messageRetentionMs=30*24*60*60_000;
export const reportRetentionMs=180*24*60*60_000;
export const reportWindowMs=30*24*60*60_000;

function closedAt(database:DatabaseSync,id:string,state:string) {
  if(!closedStates.has(state)) return undefined;
  const event=database.prepare('SELECT state,occurred_at FROM order_events WHERE order_id=? ORDER BY id DESC LIMIT 1').get(id) as {state:string;occurred_at:number}|undefined;
  return event?.state===state?event.occurred_at:undefined;
}
function pruneOrderSensitiveData(database:DatabaseSync,id:string,state:string,now:number) {
  const ended=closedAt(database,id,state);
  if(ended===undefined) return {messages:0,reports:0};
  const messages=now-ended>=messageRetentionMs?Number(database.prepare('DELETE FROM order_messages WHERE order_id=?').run(id).changes):0;
  const reports=now-ended>=reportRetentionMs?Number(database.prepare('DELETE FROM order_reports WHERE order_id=?').run(id).changes):0;
  return {messages,reports};
}
export function pruneSensitiveOrderData(now=Date.now()) {
  return transaction(database=>{
    const orders=database.prepare("SELECT id,state FROM orders WHERE state IN ('DECLINED','CANCELLED','EXPIRED','SETTLED','REFUNDED','SIGNATURE_EXPIRED')").all() as {id:string;state:string}[];
    const result={messages:0,reports:0};
    for(const order of orders) {
      const removed=pruneOrderSensitiveData(database,order.id,order.state,now);
      result.messages+=removed.messages;
      result.reports+=removed.reports;
    }
    return result;
  });
}
function blockedBetween(database:DatabaseSync,first:string,second:string) {
  return !!database.prepare('SELECT 1 FROM user_blocks WHERE (blocker=? AND blocked=?) OR (blocker=? AND blocked=?)').get(first.toLowerCase(),second.toLowerCase(),second.toLowerCase(),first.toLowerCase());
}
function safetyTarget(database:DatabaseSync,address:string,id:string) {
  const row=database.prepare('SELECT o.taker,a.maker_address FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND (o.taker=? OR a.maker_address=?)').get(id,address,address) as SafetyOrder|undefined;
  if(!row) throw new InputError('주문을 찾을 수 없습니다.',404);
  const target=row.taker.toLowerCase()===address.toLowerCase()?row.maker_address:row.taker;
  if(!target) throw new InputError('연결된 상대방 지갑이 없습니다.',409);
  return target.toLowerCase();
}
export function getOrderSafety(address:string,id:string) {
  const database=db();
  const target=safetyTarget(database,address,id);
  const order=database.prepare('SELECT state FROM orders WHERE id=?').get(id) as {state:string};
  pruneOrderSensitiveData(database,id,order.state,Date.now());
  const ended=closedAt(database,id,order.state);
  const blocked=!!database.prepare('SELECT 1 FROM user_blocks WHERE blocker=? AND blocked=?').get(address.toLowerCase(),target);
  const report=database.prepare('SELECT id,reason,details,status,created_at,reviewed_at FROM order_reports WHERE order_id=? AND reporter=?').get(id,address.toLowerCase())||null;
  return {target,blocked,report,reportable:ended===undefined||Date.now()-ended<reportWindowMs};
}
export function changeOrderBlock(address:string,id:string,action:unknown,now=Date.now()) {
  if(action!=='block'&&action!=='unblock') throw new InputError('차단 작업을 확인하세요.');
  return transaction(database=>{
    const target=safetyTarget(database,address,id);
    if(action==='block') database.prepare('INSERT OR IGNORE INTO user_blocks (blocker,blocked,created_at) VALUES (?,?,?)').run(address.toLowerCase(),target,now);
    else database.prepare('DELETE FROM user_blocks WHERE blocker=? AND blocked=?').run(address.toLowerCase(),target);
    return {target,blocked:action==='block'};
  });
}
export function reportOrderCounterparty(address:string,id:string,reason:unknown,details:unknown,now=Date.now()) {
  if(typeof reason!=='string'||!reportReasons.has(reason)) throw new InputError('신고 사유를 선택하세요.');
  if(typeof details!=='string'||details.trim().length<10||details.trim().length>1000) throw new InputError('신고 내용은 10~1000자로 입력하세요.');
  return transaction(database=>{
    const target=safetyTarget(database,address,id);
    const order=database.prepare('SELECT state FROM orders WHERE id=?').get(id) as {state:string};
    pruneOrderSensitiveData(database,id,order.state,now);
    const existing=database.prepare('SELECT id,reason,details,status,created_at FROM order_reports WHERE order_id=? AND reporter=?').get(id,address.toLowerCase()) as {id:string;reason:string;details:string;status:string;created_at:number}|undefined;
    if(existing) {
      if(existing.reason!==reason||existing.details!==details.trim()) throw new InputError('이 주문의 신고는 이미 접수되었습니다.',409);
      return {...existing};
    }
    const ended=closedAt(database,id,order.state);
    if(ended!==undefined&&now-ended>=reportWindowMs) throw new InputError('주문 종료 후 30일이 지나 신고 접수가 마감되었습니다.',409);
    const report={id:randomUUID(),reason,details:details.trim(),status:'PENDING',created_at:now};
    database.prepare('INSERT INTO order_reports (id,order_id,reporter,reported,reason,details,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(report.id,id,address.toLowerCase(),target,report.reason,report.details,report.status,report.created_at);
    return report;
  });
}
const messageStates=new Set(['RESERVED','ACCEPTED','CHAIN_SIGNING','OPEN_PENDING','OPEN','MAKER_FUNDED']);
function conversationOrder(database:DatabaseSync,address:string,id:string) {
  const row=database.prepare('SELECT o.state,a.maker_address FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND (o.taker=? OR a.maker_address=?)').get(id,address,address) as ConversationOrder|undefined;
  if(!row) throw new InputError('주문을 찾을 수 없습니다.',404);
  return row;
}
export function getOrderConversation(address:string,id:string) {
  expireReservations();
  const database=db();
  const order=conversationOrder(database,address,id);
  pruneOrderSensitiveData(database,id,order.state,Date.now());
  const events=database.prepare('SELECT id,state,actor,occurred_at FROM order_events WHERE order_id=? ORDER BY id').all(id) as {id:number;state:string;actor:string;occurred_at:number}[];
  const messages=database.prepare('SELECT id,sender,body,created_at FROM order_messages WHERE order_id=? ORDER BY id').all(id) as {id:number;sender:string;body:string;created_at:number}[];
  const items=[...events.map(event=>({kind:'state' as const,id:`state-${event.id}`,at:event.occurred_at,actor:event.actor,state:event.state})),...messages.map(message=>({kind:'message' as const,id:`message-${message.id}`,at:message.created_at,actor:message.sender,body:message.body}))].sort((a,b)=>a.at-b.at||(a.kind===b.kind?Number(a.id.split('-')[1])-Number(b.id.split('-')[1]):a.kind==='state'?-1:1));
  return {items,writable:!!order.maker_address&&messageStates.has(order.state),hasCounterparty:!!order.maker_address};
}
export function postOrderMessage(address:string,id:string,body:unknown,clientId:unknown,now=Date.now()) {
  if(typeof body!=='string'||body.trim().length===0||body.trim().length>1000) throw new InputError('메시지는 1~1000자로 입력하세요.');
  if(typeof clientId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientId)) throw new InputError('메시지 요청 ID를 확인하세요.');
  const clean=body.trim();
  expireReservations(now);
  return transaction(database=>{
    const order=conversationOrder(database,address,id);
    pruneOrderSensitiveData(database,id,order.state,now);
    if(!order.maker_address) throw new InputError('대화 상대방이 없는 예시 주문입니다.',409);
    const previous=database.prepare('SELECT id,body,created_at FROM order_messages WHERE order_id=? AND sender=? AND client_id=?').get(id,address,clientId) as {id:number;body:string;created_at:number}|undefined;
    if(previous) {
      if(previous.body!==clean) throw new InputError('요청 ID가 다른 메시지에 이미 사용되었습니다.',409);
      return {id:previous.id,body:previous.body,sender:address,created_at:previous.created_at};
    }
    if(!messageStates.has(order.state)) throw new InputError('종료된 주문에는 메시지를 보낼 수 없습니다.',409);
    const count=database.prepare('SELECT COUNT(*) AS count FROM order_messages WHERE order_id=?').get(id) as {count:number};
    if(count.count>=500) throw new InputError('이 주문의 대화 한도에 도달했습니다.',409);
    const last=database.prepare('SELECT created_at FROM order_messages WHERE order_id=? AND sender=? ORDER BY id DESC LIMIT 1').get(id,address) as {created_at:number}|undefined;
    if(last&&now-last.created_at<2000) throw new InputError('메시지는 2초 간격으로 보낼 수 있습니다.',429);
    const result=database.prepare('INSERT INTO order_messages (order_id,sender,client_id,body,created_at) VALUES (?,?,?,?,?)').run(id,address,clientId,clean,now);
    return {id:Number(result.lastInsertRowid),body:clean,sender:address,created_at:now};
  });
}
export function respondOrder(address:string,id:string,decision:'accept'|'decline',now=Date.now()) {
  if(decision!=='accept'&&decision!=='decline') throw new InputError('수락 또는 거절을 선택하세요.');
  expireReservations(now);
  return transaction(database=>{
    const row=database.prepare('SELECT o.id,o.ad_id,o.state,o.asset_amount,o.response_due_at,o.expires_at FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND a.maker_address=?').get(id,address) as {id:string,ad_id:string,state:string,asset_amount:string,response_due_at:number|null,expires_at:number}|undefined;
    if(!row) throw new InputError('담당 주문을 찾을 수 없습니다.',404);
    if(row.state!=='RESERVED') throw new InputError('이미 처리된 주문입니다.',409);
    if(decision==='accept') {
      const expires=now+15*60_000;
      database.prepare("UPDATE orders SET state='ACCEPTED',expires_at=? WHERE id=?").run(expires,id);
      recordOrderEvent(database,id,'ACCEPTED',address,now);
      return {id,state:'ACCEPTED',expires_at:expires};
    }
    const ad=database.prepare('SELECT available_units FROM ads WHERE id=?').get(row.ad_id) as {available_units:string};
    database.prepare('UPDATE ads SET available_units=?,version=version+1 WHERE id=?').run((BigInt(ad.available_units)+BigInt(row.asset_amount)).toString(),row.ad_id);
    database.prepare("UPDATE orders SET state='DECLINED' WHERE id=?").run(id);
    recordOrderEvent(database,id,'DECLINED',address,now);
    return {id,state:'DECLINED'};
  });
}
export function cancelOrder(address:string,id:string) {
  expireReservations();
  return transaction(database=>{
    const row=database.prepare('SELECT * FROM orders WHERE id=? AND taker=?').get(id,address) as {state:string,ad_id:string,asset_amount:string}|undefined;
    if(!row) throw new InputError('주문을 찾을 수 없습니다.',404);
    if(row.state!=='RESERVED'&&row.state!=='ACCEPTED') throw new InputError('이미 종료된 예약입니다.',409);
    const ad=database.prepare('SELECT available_units FROM ads WHERE id=?').get(row.ad_id) as {available_units:string};
    database.prepare('UPDATE ads SET available_units=?,version=version+1 WHERE id=?').run((BigInt(ad.available_units)+BigInt(row.asset_amount)).toString(),row.ad_id);
    database.prepare("UPDATE orders SET state='CANCELLED' WHERE id=?").run(id);
    recordOrderEvent(database,id,'CANCELLED',address,Date.now());
    return {id,state:'CANCELLED'};
  });
}
export function createChallenge(address:string,message:string,nonce:string,now=Date.now()) {
  const hash=digest(nonce);
  transaction(database=>{
    database.prepare('DELETE FROM challenges WHERE expires_at<=? OR address=?').run(now,address);
    database.prepare('INSERT INTO challenges VALUES (?,?,?,?)').run(hash,address,message,now+5*60_000);
  });
}
export function consumeChallenge(nonce:string,now=Date.now()) {
  return transaction(database=>{
    const row=database.prepare('SELECT address,message,expires_at FROM challenges WHERE nonce_hash=?').get(digest(nonce)) as {address:string,message:string,expires_at:number}|undefined;
    database.prepare('DELETE FROM challenges WHERE nonce_hash=?').run(digest(nonce));
    return row && row.expires_at>now ? row : undefined;
  });
}
export function createSession(address:string,now=Date.now()) {
  const token=randomBytes(32).toString('base64url');
  db().prepare('DELETE FROM sessions WHERE expires_at<=?').run(now);
  db().prepare('INSERT INTO sessions VALUES (?,?,?)').run(digest(token),address,now+24*60*60_000);
  return token;
}
export function getSession(token:string|undefined,now=Date.now()) {
  if(!token) return undefined;
  const row=db().prepare('SELECT address,expires_at FROM sessions WHERE token_hash=?').get(digest(token)) as {address:string,expires_at:number}|undefined;
  return row && row.expires_at>now ? row.address : undefined;
}
export function deleteSession(token:string|undefined) {if(token) db().prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));}
