import 'server-only';
import { decodeEventLog, hashTypedData } from 'viem';
import { chainClient, getChainConfig, verifyChainConfig, type ChainConfig } from './chain-config';
import { ChainTerms, escrowAbi, typedOrder } from './chain-abi';
import { db, InputError, transaction } from './store';

type EventRow={orderId:string;event:string;txHash:string;logIndex:number;blockNumber:number;blockHash:string;data:string};
type ChainRow={order_id:string;onchain_id:string;state:string;open_tx:string|null;terms_json:string;ad_id:string;asset_amount:string};
type Checkpoint={block_number:number;block_hash:string};
type SyncRow={contract:string;start_block:number};
type Scan={from:bigint;events:EventRow[];checkpoints:Checkpoint[];reset:boolean;basisSync:SyncRow|undefined;basisCheckpoint:Checkpoint|undefined};
class StaleScan extends Error {}
const sameSync=(a:SyncRow|undefined,b:SyncRow|undefined)=>a?.contract===b?.contract&&a?.start_block===b?.start_block;
const sameCheckpoint=(a:Checkpoint|undefined,b:Checkpoint|undefined)=>a?.block_number===b?.block_number&&a?.block_hash===b?.block_hash;
const terminal=new Set(['SETTLED','REFUNDED','CANCELLED','EXPIRED','SIGNATURE_EXPIRED']);
const eventState:Record<string,string>={OrderOpened:'OPEN',MakerDeposited:'MAKER_FUNDED',OrderSettled:'SETTLED',OrderCancelled:'CANCELLED',OrderExpired:'EXPIRED',MakerRefunded:'REFUNDED'};
const json=(value:unknown)=>JSON.stringify(value,(_key,item)=>typeof item==='bigint'?item.toString():item);

async function canonicalEvents(config:ChainConfig):Promise<Scan> {
  const client=chainClient(config);
  const head=await client.getBlockNumber();
  const safe=head-BigInt(config.confirmations-1);
  const safeHash=safe>=config.startBlock?(await client.getBlock({blockNumber:safe})).hash?.toLowerCase():undefined;
  if(safe>=config.startBlock&&!safeHash) throw new InputError('확정 블록 해시를 확인할 수 없습니다.',503);
  const sync=db().prepare('SELECT contract,start_block FROM chain_sync WHERE chain_id=?').get(config.chainId) as SyncRow|undefined;
  const basisCheckpoint=db().prepare('SELECT block_number,block_hash FROM chain_blocks WHERE chain_id=? ORDER BY block_number DESC LIMIT 1').get(config.chainId) as Checkpoint|undefined;
  const reset=!sync||sync.contract!==config.contract.toLowerCase()||BigInt(sync.start_block)!==config.startBlock;
  const checkpoints=reset?[]:db().prepare('SELECT block_number,block_hash FROM chain_blocks WHERE chain_id=? AND block_number<=? ORDER BY block_number DESC').all(config.chainId,Number(safe)) as Checkpoint[];
  let from=config.startBlock;
  for(const checkpoint of checkpoints) {
    if(BigInt(checkpoint.block_number)<config.startBlock) continue;
    const block=await client.getBlock({blockNumber:BigInt(checkpoint.block_number)});
    if(block.hash?.toLowerCase()===checkpoint.block_hash) {from=BigInt(checkpoint.block_number)+1n;break;}
  }
  const found:EventRow[]=[];
  const scanned:Checkpoint[]=[];
  for(let chunk=from;chunk<=safe;chunk+=500n) {
    const to=chunk+499n<safe?chunk+499n:safe;
    const logs=await client.getLogs({address:config.contract,fromBlock:chunk,toBlock:to});
    const block=await client.getBlock({blockNumber:to});
    if(!block.hash) throw new InputError('확정 블록 해시를 확인할 수 없습니다.',503);
    scanned.push({block_number:Number(to),block_hash:block.hash.toLowerCase()});
    for(const log of logs) {
      let decoded:ReturnType<typeof decodeEventLog>;
      try {decoded=decodeEventLog({abi:escrowAbi,data:log.data,topics:log.topics});}
      catch {continue;}
      const state=eventState[decoded.eventName];
      if(!state) continue;
      const args=decoded.args as Record<string,unknown>;
      const id=args.orderId;
      if(typeof id!=='string'||!log.transactionHash||!log.blockHash||log.blockNumber===null||log.logIndex===null) continue;
      found.push({orderId:id.toLowerCase(),event:decoded.eventName,txHash:log.transactionHash.toLowerCase(),logIndex:log.logIndex,blockNumber:Number(log.blockNumber),blockHash:log.blockHash.toLowerCase(),data:json(args)});
    }
  }
  const finalHead=await client.request({method:'eth_blockNumber'});
  if(BigInt(finalHead)!==head) throw new StaleScan();
  if(safeHash) {
    const block=await client.getBlock({blockNumber:safe});
    if(block.hash?.toLowerCase()!==safeHash) throw new InputError('스캔 중 블록이 변경되었습니다. 다시 시도하세요.',503);
  }
  return {from,events:found.sort((a,b)=>a.blockNumber-b.blockNumber||a.logIndex-b.logIndex),checkpoints:scanned,reset,basisSync:sync,basisCheckpoint};
}

function effect(state:string,amount:bigint) {
  if(state==='SETTLED') return {total:-amount,available:0n};
  if(state==='REFUNDED'||state==='CANCELLED'||state==='EXPIRED'||state==='SIGNATURE_EXPIRED') return {total:0n,available:amount};
  return {total:0n,available:0n};
}

function project(config:ChainConfig,scan:Scan) {
  return transaction(database=>{
    const sync=database.prepare('SELECT contract,start_block FROM chain_sync WHERE chain_id=?').get(config.chainId) as SyncRow|undefined;
    const checkpoint=database.prepare('SELECT block_number,block_hash FROM chain_blocks WHERE chain_id=? ORDER BY block_number DESC LIMIT 1').get(config.chainId) as Checkpoint|undefined;
    if(!sameSync(sync,scan.basisSync)||!sameCheckpoint(checkpoint,scan.basisCheckpoint)) throw new StaleScan();
    const rows=database.prepare('SELECT c.order_id,c.onchain_id,c.state,c.open_tx,c.terms_json,o.ad_id,o.asset_amount FROM chain_orders c JOIN orders o ON o.id=c.order_id WHERE c.chain_id=? AND lower(c.contract)=?').all(config.chainId,config.contract.toLowerCase()) as ChainRow[];
    const known=new Map(rows.map(row=>[row.onchain_id.toLowerCase(),row]));
    const matched=scan.events.filter(event=>known.has(event.orderId));
    for(const event of matched.filter(event=>event.event==='OrderOpened')) {
      const row=known.get(event.orderId)!;
      const args=JSON.parse(event.data) as {termsHash:string;maker:string;taker:string};
      const terms=JSON.parse(row.terms_json) as ChainTerms;
      const digest=hashTypedData(typedOrder(config.chainId,config.contract,terms));
      if(args.termsHash.toLowerCase()!==digest.toLowerCase()||args.maker.toLowerCase()!==terms.maker.toLowerCase()||args.taker.toLowerCase()!==terms.taker.toLowerCase()) throw new InputError('온체인 약정이 서버 주문과 일치하지 않습니다.',503);
    }
    if(scan.reset) {
      database.prepare('DELETE FROM chain_events WHERE chain_id=?').run(config.chainId);
      database.prepare('DELETE FROM chain_blocks WHERE chain_id=?').run(config.chainId);
    } else {
      database.prepare('DELETE FROM chain_events WHERE chain_id=? AND block_number>=?').run(config.chainId,Number(scan.from));
      database.prepare('DELETE FROM chain_blocks WHERE chain_id=? AND block_number>=?').run(config.chainId,Number(scan.from));
    }
    database.prepare('INSERT OR REPLACE INTO chain_sync (chain_id,contract,start_block) VALUES (?,?,?)').run(config.chainId,config.contract.toLowerCase(),Number(config.startBlock));
    const insertEvent=database.prepare('INSERT INTO chain_events (chain_id,tx_hash,log_index,block_number,block_hash,event_name,order_id,data_json) VALUES (?,?,?,?,?,?,?,?)');
    const insertBlock=database.prepare('INSERT OR REPLACE INTO chain_blocks (chain_id,block_number,block_hash) VALUES (?,?,?)');
    for(const event of matched) {
      const row=known.get(event.orderId)!;
      insertEvent.run(config.chainId,event.txHash,event.logIndex,event.blockNumber,event.blockHash,event.event,row.order_id,event.data);
    }
    for(const checkpoint of scan.checkpoints) insertBlock.run(config.chainId,checkpoint.block_number,checkpoint.block_hash);
    const stored=database.prepare('SELECT order_id,event_name FROM chain_events WHERE chain_id=? ORDER BY block_number,log_index').all(config.chainId) as {order_id:string;event_name:string}[];
    for(const row of rows) {
      const own=stored.filter(event=>event.order_id===row.order_id);
      let next=row.state==='SIGNATURE_EXPIRED'?'SIGNATURE_EXPIRED':row.open_tx?'OPEN_PENDING':'CHAIN_SIGNING';
      let seenOpen=false;
      for(const event of own) {
        if(event.event_name==='OrderOpened') seenOpen=true;
        if(!seenOpen) continue;
        next=eventState[event.event_name]||next;
      }
      if(next===row.state) continue;
      const oldEffect=effect(row.state,BigInt(row.asset_amount));
      const newEffect=effect(next,BigInt(row.asset_amount));
      const ad=database.prepare('SELECT total_units,available_units FROM ads WHERE id=?').get(row.ad_id) as {total_units:string;available_units:string};
      const total=BigInt(ad.total_units)+newEffect.total-oldEffect.total;
      const available=BigInt(ad.available_units)+newEffect.available-oldEffect.available;
      if(total<0n||available<0n||available>total) throw new InputError('체인 재구성으로 광고 재고 충돌이 발생했습니다. 수동 재조정이 필요합니다.',503);
      database.prepare('UPDATE ads SET total_units=?,available_units=?,version=version+1 WHERE id=?').run(total.toString(),available.toString(),row.ad_id);
      database.prepare('UPDATE chain_orders SET state=? WHERE order_id=?').run(next,row.order_id);
      database.prepare('UPDATE orders SET state=? WHERE id=?').run(next,row.order_id);
      database.prepare('INSERT INTO order_events (order_id,state,actor,occurred_at) VALUES (?,?,?,?)').run(row.order_id,next,terminal.has(row.state)?'chain-reorg':'chain',Date.now());
    }
    return {confirmedEvents:stored.length,orders:rows.length};
  });
}

let ongoing:Promise<{confirmedEvents:number;orders:number}>|undefined;
export async function syncChain() {
  if(ongoing) return ongoing;
  ongoing=(async()=>{
    const config=getChainConfig();
    if(!config) throw new InputError('로컬 체인이 설정되지 않았습니다.',503);
    for(let attempt=0;attempt<3;attempt++) {
      let scan:Scan;
      try {
        await verifyChainConfig(config);
        scan=await canonicalEvents(config);
      } catch(error) {
        if(error instanceof StaleScan) continue;
        if(error instanceof InputError) throw error;
        throw new InputError('로컬 체인 RPC를 확인할 수 없습니다. 상태를 갱신하지 않았습니다.',503);
      }
      try {return project(config,scan);}
      catch(error) {if(error instanceof StaleScan) continue;throw error;}
    }
    throw new InputError('동시 체인 동기화 중 블록 또는 체크포인트가 변경되었습니다. 다시 시도하세요.',503);
  })().finally(()=>{ongoing=undefined;});
  return ongoing;
}
