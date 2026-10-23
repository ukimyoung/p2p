import 'server-only';
import { randomBytes } from 'node:crypto';
import { getAddress, isHex, verifyTypedData, type Address, type Hex } from 'viem';
import { chainClient, getChainConfig, publicChainConfig, type ChainConfig } from './chain-config';
import { ChainTerms, escrowAbi, typedOrder } from './chain-abi';
import { syncChain } from './chain-indexer';
import { db, expireReservations, InputError, transaction } from './store';
import { units } from './market';

type AcceptedRow={id:string;taker:string;state:string;amount:string;asset_amount:string;fee:string;terms_json:string|null;maker_address:string|null;expires_at:number};
type ChainRow={order_id:string;onchain_id:string;chain_id:number;contract:string;terms_json:string;maker_signature:string|null;taker_signature:string|null;open_tx:string|null;maker_tx:string|null;taker_tx:string|null;final_tx:string|null;state:string;created_at:number};
const random256=()=>`0x${randomBytes(32).toString('hex')}` as Hex;

function configured() {
  const config=getChainConfig();
  if(!config) throw new InputError('로컬 체인 기능이 설정되지 않았습니다.',503);
  return config;
}

export async function checkedChainConfig() {
  const config=configured();
  const client=chainClient(config);
  if(await client.getChainId()!==config.chainId) throw new InputError('로컬 RPC 체인 ID가 다릅니다.',503);
  return config;
}

function participant(address:string,id:string) {
  const row=db().prepare('SELECT o.id,o.taker,a.maker_address FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND (o.taker=? OR a.maker_address=?)').get(id,address,address) as {id:string;taker:string;maker_address:string|null}|undefined;
  if(!row) throw new InputError('주문을 찾을 수 없습니다.',404);
  return row;
}

function chainRow(id:string) {
  return db().prepare('SELECT * FROM chain_orders WHERE order_id=?').get(id) as ChainRow|undefined;
}

export function prepareChainOrder(address:string,id:string,config:ChainConfig,now=Date.now()) {
  expireReservations(now);
  return transaction(database=>{
    const row=database.prepare('SELECT o.*,a.maker_address FROM orders o JOIN ads a ON a.id=o.ad_id WHERE o.id=? AND o.taker=?').get(id,address) as AcceptedRow|undefined;
    if(!row) throw new InputError('내 주문을 찾을 수 없습니다.',404);
    if(row.state!=='ACCEPTED'||!row.maker_address) throw new InputError('광고주가 수락한 주문만 전환할 수 있습니다.',409);
    if(database.prepare('SELECT 1 FROM chain_orders WHERE order_id=?').get(id)) throw new InputError('이미 체인 주문이 준비되었습니다.',409);
    const snapshot=JSON.parse(row.terms_json||'{}') as {side?:string;asset?:string;makerAddress?:string};
    if(snapshot.asset!=='ETH'||(snapshot.side!=='buy'&&snapshot.side!=='sell')||snapshot.makerAddress?.toLowerCase()!==row.maker_address.toLowerCase()) throw new InputError('이 주문은 로컬 WETH 체인 거래 대상이 아닙니다.',409);
    const amount=units(row.amount);
    const fee=units(row.fee);
    const asset=BigInt(row.asset_amount);
    if(amount<=fee) throw new InputError('수수료가 거래 금액보다 큽니다.',409);
    const maker=getAddress(row.maker_address) as Address;
    const taker=getAddress(row.taker) as Address;
    const makerPaysUsdc=snapshot.side==='sell';
    const signatureDeadline=Math.min(Math.floor(now/1000)+10*60,Math.floor(row.expires_at/1000));
    if(signatureDeadline<=Math.floor(now/1000)+60) throw new InputError('수락한 주문의 개설 기한이 너무 짧습니다.',409);
    const terms:ChainTerms={
      orderId:random256(),maker,taker,makerNonce:BigInt(random256()).toString(),takerNonce:BigInt(random256()).toString(),
      makerToken:makerPaysUsdc?config.usdc:config.weth,takerToken:makerPaysUsdc?config.weth:config.usdc,
      makerDeposit:(makerPaysUsdc?amount:asset).toString(),takerDeposit:(makerPaysUsdc?asset:amount+fee).toString(),
      makerReceive:(makerPaysUsdc?asset:amount).toString(),takerReceive:(makerPaysUsdc?amount-fee:asset).toString(),
      fee:fee.toString(),signatureDeadline:String(signatureDeadline),
    };
    database.prepare("INSERT INTO chain_orders (order_id,onchain_id,chain_id,contract,terms_json,state,created_at) VALUES (?,?,?,?,?,'CHAIN_SIGNING',?)")
      .run(id,terms.orderId,config.chainId,config.contract,JSON.stringify(terms),now);
    database.prepare("UPDATE orders SET state='CHAIN_SIGNING' WHERE id=?").run(id);
    database.prepare('INSERT INTO order_events (order_id,state,actor,occurred_at) VALUES (?,?,?,?)').run(id,'CHAIN_SIGNING',address,now);
    return terms;
  });
}

export async function signChainOrder(address:string,id:string,signature:unknown,config:ChainConfig) {
  const party=participant(address,id);
  const row=chainRow(id);
  if(!row) throw new InputError('체인 주문을 찾을 수 없습니다.',404);
  if(row.state!=='CHAIN_SIGNING') throw new InputError('이미 개설 중인 주문입니다.',409);
  if(row.chain_id!==config.chainId||row.contract.toLowerCase()!==config.contract.toLowerCase()) throw new InputError('체인 설정이 변경되었습니다.',409);
  if(typeof signature!=='string'||!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new InputError('지갑 서명을 확인하세요.');
  const terms=JSON.parse(row.terms_json) as ChainTerms;
  if(Math.floor(Date.now()/1000)>Number(terms.signatureDeadline)) throw new InputError('주문 서명 기한이 지났습니다.',409);
  const role=party.maker_address?.toLowerCase()===address.toLowerCase()?'maker':'taker';
  const valid=await verifyTypedData({...typedOrder(config.chainId,config.contract,terms),address:getAddress(address) as Address,signature:signature as Hex});
  if(!valid) throw new InputError('약정 서명이 일치하지 않습니다.',401);
  return transaction(database=>{
    const latest=database.prepare('SELECT state FROM chain_orders WHERE order_id=?').get(id) as {state:string}|undefined;
    if(latest?.state!=='CHAIN_SIGNING') throw new InputError('이미 개설 중인 주문입니다.',409);
    database.prepare(`UPDATE chain_orders SET ${role}_signature=? WHERE order_id=?`).run(signature,id);
    return {role};
  });
}

export async function releaseExpiredSignature(address:string,id:string,config:ChainConfig) {
  participant(address,id);
  await syncChain();
  const row=chainRow(id);
  if(!row||!['CHAIN_SIGNING','OPEN_PENDING'].includes(row.state)) throw new InputError('서명 대기 중인 체인 주문이 아닙니다.',409);
  if(row.chain_id!==config.chainId||row.contract.toLowerCase()!==config.contract.toLowerCase()) throw new InputError('체인 설정이 변경되었습니다.',409);
  const terms=JSON.parse(row.terms_json) as ChainTerms;
  const client=chainClient(config);
  const [block,onchain]=await Promise.all([
    client.getBlock(),
    client.readContract({address:config.contract,abi:escrowAbi,functionName:'getOrder',args:[terms.orderId]}),
  ]);
  if(block.timestamp<=BigInt(terms.signatureDeadline)) throw new InputError('체인에서 서명 기한이 아직 지나지 않았습니다.',409);
  if(onchain.state!==0) throw new InputError('에스크로가 이미 개설되었습니다. 체인 상태를 새로고침하세요.',409);
  return transaction(database=>{
    const latest=database.prepare('SELECT state FROM chain_orders WHERE order_id=?').get(id) as {state:string}|undefined;
    if(!latest||!['CHAIN_SIGNING','OPEN_PENDING'].includes(latest.state)) throw new InputError('주문 상태가 변경되었습니다.',409);
    const ad=database.prepare('SELECT a.id,a.available_units,a.total_units,o.asset_amount FROM ads a JOIN orders o ON o.ad_id=a.id WHERE o.id=?').get(id) as {id:string;available_units:string;total_units:string;asset_amount:string};
    const available=BigInt(ad.available_units)+BigInt(ad.asset_amount);
    if(available>BigInt(ad.total_units)) throw new InputError('광고 재고가 주문과 일치하지 않습니다.',503);
    database.prepare('UPDATE ads SET available_units=?,version=version+1 WHERE id=?').run(available.toString(),ad.id);
    database.prepare("UPDATE chain_orders SET state='SIGNATURE_EXPIRED' WHERE order_id=?").run(id);
    database.prepare("UPDATE orders SET state='SIGNATURE_EXPIRED' WHERE id=?").run(id);
    database.prepare('INSERT INTO order_events (order_id,state,actor,occurred_at) VALUES (?,?,?,?)').run(id,'SIGNATURE_EXPIRED',address,Date.now());
  });
}

export function noteChainTx(address:string,id:string,action:unknown,hash:unknown) {
  const party=participant(address,id);
  if(typeof hash!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(hash)||!isHex(hash)) throw new InputError('트랜잭션 해시를 확인하세요.');
  const role=party.maker_address?.toLowerCase()===address.toLowerCase()?'maker':'taker';
  return transaction(database=>{
    const row=database.prepare('SELECT * FROM chain_orders WHERE order_id=?').get(id) as ChainRow|undefined;
    if(!row) throw new InputError('체인 주문을 찾을 수 없습니다.',404);
    if(action==='open') {
      if(!row.maker_signature||!row.taker_signature||!['CHAIN_SIGNING','OPEN_PENDING'].includes(row.state)) throw new InputError('두 당사자의 서명이 필요합니다.',409);
      database.prepare("UPDATE chain_orders SET open_tx=?,state='OPEN_PENDING' WHERE order_id=?").run(hash,id);
      database.prepare("UPDATE orders SET state='OPEN_PENDING' WHERE id=?").run(id);
    } else if(action==='maker'&&role==='maker'&&row.state==='OPEN') {
      database.prepare('UPDATE chain_orders SET maker_tx=? WHERE order_id=?').run(hash,id);
    } else if(action==='taker'&&role==='taker'&&row.state==='MAKER_FUNDED') {
      database.prepare('UPDATE chain_orders SET taker_tx=? WHERE order_id=?').run(hash,id);
    } else if(['cancel','expire','refund'].includes(String(action))&&['OPEN','MAKER_FUNDED'].includes(row.state)) {
      database.prepare('UPDATE chain_orders SET final_tx=? WHERE order_id=?').run(hash,id);
    } else throw new InputError('현재 상태에서 기록할 수 없는 거래입니다.',409);
    return {hash};
  });
}

export function getChainOrder(address:string,id:string) {
  const config=configured();
  participant(address,id);
  const row=chainRow(id);
  if(!row) return {config:publicChainConfig(config),chain:null};
  const events=db().prepare('SELECT event_name,tx_hash,block_number,block_hash,log_index,data_json FROM chain_events WHERE order_id=? ORDER BY block_number,log_index').all(id);
  return {config:publicChainConfig(config),chain:{...row,terms:JSON.parse(row.terms_json) as ChainTerms,events}};
}
