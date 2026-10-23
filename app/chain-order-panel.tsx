'use client';
import { useEffect, useRef, useState } from 'react';
import { decodeFunctionResult, encodeFunctionData, formatEther, formatUnits, type Address, type Hex } from 'viem';
import { ChainTerms, contractTerms, erc20Abi, escrowAbi, typedOrder } from '../lib/chain-abi';

type Provider={request:(args:{method:string;params?:unknown[]})=>Promise<unknown>;on?:(event:string,listener:(value:unknown)=>void)=>void;removeListener?:(event:string,listener:(value:unknown)=>void)=>void};
type Config={chainId:number;contract:Address;usdc:Address;weth:Address;confirmations:number};
type Event={event_name:string;tx_hash:string;block_number:number;data_json:string};
type Chain={state:string;terms:ChainTerms;maker_signature:string|null;taker_signature:string|null;open_tx:string|null;events:Event[]};
type Detail={config:Config;chain:Chain|null};
type WalletAction='approve'|'open'|'maker'|'taker'|'cancel'|'expire'|'refund';
type PendingTx={action:WalletAction;hash:string;nonce?:string;submittedAt:number};
type GasQuote={action:WalletAction;to:Address;data:Hex;gas:bigint;gasPrice:bigint;quotedAt:number;orderId:string};
type Issue={message:string;action?:WalletAction;hash?:string};
const chainLabels:Record<string,string>={CHAIN_SIGNING:'두 지갑 서명 대기',OPEN_PENDING:'개설 확인 대기',OPEN:'Maker 예치 대기',MAKER_FUNDED:'Taker 예치 대기',SETTLED:'교환 완료',REFUNDED:'Maker 환불',CANCELLED:'예치 전 취소',EXPIRED:'예치 기한 만료',SIGNATURE_EXPIRED:'서명 만료 · 재고 복구'};
const eventLabels:Record<string,string>={OrderOpened:'에스크로 개설',MakerDeposited:'Maker 예치',OrderSettled:'원자적 정산',OrderCancelled:'예치 전 취소',OrderExpired:'예치 기한 만료',MakerRefunded:'Maker 환불'};
const actionLabels:Record<WalletAction,string>={approve:'토큰 승인',open:'에스크로 개설',maker:'Maker 예치',taker:'Taker 예치·정산',cancel:'예치 전 취소',expire:'미예치 만료',refund:'Maker 환불'};
const completedState:Record<Exclude<WalletAction,'approve'>,string[]>={open:['OPEN','MAKER_FUNDED','SETTLED','CANCELLED','EXPIRED','REFUNDED'],maker:['MAKER_FUNDED','SETTLED','REFUNDED'],taker:['SETTLED'],cancel:['CANCELLED'],expire:['EXPIRED'],refund:['REFUNDED']};

function walletError(error:unknown) {
  const input=error as {code?:number;message?:string};
  if(input?.code===4001||/user rejected|user denied|request rejected/i.test(input?.message||'')) return '지갑에서 요청을 취소했습니다. 주문 상태를 확인한 뒤 다시 시도할 수 있습니다.';
  return input?.message||'지갑 요청을 완료하지 못했습니다.';
}
function depositDeadline(chain:Chain) {
  const event=chain.events.findLast(item=>item.event_name===(chain.state==='OPEN'?'OrderOpened':'MakerDeposited'));
  return event?Number(JSON.parse(event.data_json)[chain.state==='OPEN'?'makerDeadline':'takerDeadline']):0;
}
function canSend(chain:Chain|null,action:WalletAction,role:'maker'|'taker') {
  if(!chain)return false;
  if(action==='open')return ['CHAIN_SIGNING','OPEN_PENDING'].includes(chain.state)&&!!chain.maker_signature&&!!chain.taker_signature&&Date.now()/1000<=Number(chain.terms.signatureDeadline);
  if(['approve','maker','taker'].includes(action)&&depositDeadline(chain)>0&&Date.now()/1000>depositDeadline(chain))return false;
  if(action==='approve'||action==='maker')return role==='maker'&&chain.state==='OPEN'||role==='taker'&&action==='approve'&&chain.state==='MAKER_FUNDED';
  if(action==='taker')return role==='taker'&&chain.state==='MAKER_FUNDED';
  if(action==='cancel'||action==='expire')return chain.state==='OPEN';
  return chain.state==='MAKER_FUNDED';
}

function walletTransaction(current:Detail,action:WalletAction,role:'maker'|'taker') {
  const chain=current.chain;
  if(!chain) throw new Error('체인 주문이 없습니다.');
  let to:Address=current.config.contract;
  let data:Hex;
  if(action==='approve') {
    to=role==='maker'?chain.terms.makerToken:chain.terms.takerToken;
    const amount=BigInt(role==='maker'?chain.terms.makerDeposit:chain.terms.takerDeposit);
    data=encodeFunctionData({abi:erc20Abi,functionName:'approve',args:[current.config.contract,amount]});
  } else if(action==='open') {
    if(!chain.maker_signature||!chain.taker_signature) throw new Error('양측 서명이 필요합니다.');
    data=encodeFunctionData({abi:escrowAbi,functionName:'openOrder',args:[contractTerms(chain.terms),chain.maker_signature as Hex,chain.taker_signature as Hex]});
  } else {
    const method={maker:'depositMaker',taker:'depositTaker',cancel:'cancelUnfunded',expire:'expireUnfunded',refund:'refundMaker'} as const;
    data=encodeFunctionData({abi:escrowAbi,functionName:method[action],args:[chain.terms.orderId]});
  }
  return {to,data};
}

async function jsonPost(path:string,body:unknown) {
  const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'체인 작업에 실패했습니다.');
  return data as Detail;
}

export default function ChainOrderPanel({id,wallet,role,onChanged,onNotice}:{id:string;wallet:string;role:'maker'|'taker';onChanged:()=>Promise<void>;onNotice:(message:string)=>void}) {
  const [open,setOpen]=useState(false);
  const [enabled,setEnabled]=useState(false);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [balance,setBalance]=useState<bigint|null>(null);
  const [allowance,setAllowance]=useState<bigint|null>(null);
  const [working,setWorking]=useState(false);
  const [pending,setPending]=useState<PendingTx|null>(null);
  const [gasQuote,setGasQuote]=useState<GasQuote|null>(null);
  const [walletIssue,setWalletIssue]=useState('지갑 상태 확인 중');
  const [issue,setIssue]=useState<Issue|null>(null);
  const lastState=useRef<string|null>(null);
  const checking=useRef(false);
  const path=`/api/v1/orders/${id}/chain`;
  const pendingKey=`peer:pending:${wallet.toLowerCase()}:${id}`;
  const provider=()=>(window as Window & {ethereum?:Provider}).ethereum;
  function savePending(next:PendingTx|null) {
    setPending(next);
    if(next)setGasQuote(null);
    try {if(next)localStorage.setItem(pendingKey,JSON.stringify(next));else localStorage.removeItem(pendingKey);} catch {}
  }

  async function load() {
    const response=await fetch(path,{cache:'no-store'});
    const data=await response.json();
    if(!response.ok) throw new Error(data.error||'체인 주문을 읽지 못했습니다.');
    setDetail(data as Detail);
    return data as Detail;
  }

  useEffect(()=>{let active=true;fetch('/api/v1/chain/config',{cache:'no-store'}).then(r=>r.json()).then(data=>{if(active)setEnabled(data.enabled===true);}).catch(()=>{});return()=>{active=false;};},[]);
  useEffect(()=>{
    try {
      const saved=JSON.parse(localStorage.getItem(pendingKey)||sessionStorage.getItem(pendingKey)||'null') as PendingTx|null;
      if(saved&&/^0x[0-9a-fA-F]{64}$/.test(saved.hash)&&Object.hasOwn(actionLabels,saved.action)) {
        const restored={...saved,nonce:saved.nonce&&/^0x[0-9a-fA-F]+$/.test(saved.nonce)?saved.nonce:undefined,submittedAt:Number.isFinite(saved.submittedAt)?saved.submittedAt:Date.now()};
        setPending(restored);localStorage.setItem(pendingKey,JSON.stringify(restored));
      }
      sessionStorage.removeItem(pendingKey);
    } catch {try {localStorage.removeItem(pendingKey);sessionStorage.removeItem(pendingKey);} catch {}}
  },[pendingKey]);
  useEffect(()=>{
    if(!open||!detail)return;
    const ethereum=provider();
    if(!ethereum){setWalletIssue('EVM 브라우저 지갑이 필요합니다.');return;}
    let active=true;
    const refresh=()=>{void activeWallet(detail.config).then(()=>{if(active){setWalletIssue('');void readFunds(detail).catch(()=>{});}}).catch(error=>{if(active){setBalance(null);setAllowance(null);setWalletIssue(walletError(error));}});};
    const onChange=()=>{setGasQuote(null);refresh();};
    ethereum.on?.('accountsChanged',onChange);ethereum.on?.('chainChanged',onChange);ethereum.on?.('disconnect',onChange);
    refresh();
    return()=>{active=false;ethereum.removeListener?.('accountsChanged',onChange);ethereum.removeListener?.('chainChanged',onChange);ethereum.removeListener?.('disconnect',onChange);};
  },[open,detail?.config.chainId,detail?.config.contract,wallet]);
  useEffect(()=>{setGasQuote(null);},[detail?.chain?.state,wallet,id,role]);
  useEffect(()=>{
    if(!open||!enabled)return;
    let active=true;
    const poll=()=>{void load().then(data=>{if(!active)return;void activeWallet(data.config).then(()=>readFunds(data)).then(()=>{if(active)setWalletIssue('');}).catch(error=>{if(active){setBalance(null);setAllowance(null);setWalletIssue(walletError(error));}});const state=data.chain?.state||null;if(lastState.current!==null&&lastState.current!==state)void onChanged().catch(error=>onNotice(error.message));lastState.current=state;}).catch(error=>{if(active)onNotice(error.message);});};
    poll();const timer=setInterval(poll,5000);
    return()=>{active=false;clearInterval(timer);};
  },[open,enabled,id,wallet]);
  useEffect(()=>{
    if(!open||!pending)return;
    const timer=setInterval(()=>{void checkPending(pending).catch(error=>setIssue({message:walletError(error),hash:pending.hash}));},5000);
    void checkPending(pending).catch(error=>setIssue({message:walletError(error),hash:pending.hash}));
    return()=>clearInterval(timer);
  },[open,pending,id,wallet]);

  async function activeWallet(config:Config) {
    const ethereum=provider();
    if(!ethereum) throw new Error('EVM 브라우저 지갑이 필요합니다.');
    const accounts=await ethereum.request({method:'eth_accounts'}) as string[];
    if(!accounts.some(account=>account.toLowerCase()===wallet.toLowerCase())) throw new Error('로그인한 지갑 계정으로 전환하세요.');
    const chainId=await ethereum.request({method:'eth_chainId'});
    if(chainId!==`0x${config.chainId.toString(16)}`) throw new Error('지갑을 로컬 Anvil 체인(31337)으로 전환하세요.');
    return ethereum;
  }

  async function actionComplete(item:PendingTx,current:Detail) {
    if(!current.chain)return false;
    if(item.action!=='approve')return completedState[item.action].includes(current.chain.state);
    const funds=await readFunds(current).catch(()=>null);
    return !!funds&&funds.allowance>=BigInt(role==='maker'?current.chain.terms.makerDeposit:current.chain.terms.takerDeposit);
  }

  async function call(ethereum:Provider,to:Address,data:Hex) {
    return await ethereum.request({method:'eth_call',params:[{from:wallet,to,data},'latest']}) as Hex;
  }

  async function readFunds(current:Detail) {
    const chain=current.chain;
    if(!chain||!['OPEN','MAKER_FUNDED'].includes(chain.state)) {setBalance(null);setAllowance(null);return null;}
    if(chain.state==='OPEN'&&role!=='maker'||chain.state==='MAKER_FUNDED'&&role!=='taker') {setBalance(null);setAllowance(null);return null;}
    const ethereum=await activeWallet(current.config);
    const token=role==='maker'?chain.terms.makerToken:chain.terms.takerToken;
    const [balanceHex,allowanceHex]=await Promise.all([
      call(ethereum,token,encodeFunctionData({abi:erc20Abi,functionName:'balanceOf',args:[wallet as Address]})),
      call(ethereum,token,encodeFunctionData({abi:erc20Abi,functionName:'allowance',args:[wallet as Address,current.config.contract]})),
    ]);
    const nextBalance=decodeFunctionResult({abi:erc20Abi,functionName:'balanceOf',data:balanceHex});
    const nextAllowance=decodeFunctionResult({abi:erc20Abi,functionName:'allowance',data:allowanceHex});
    setBalance(nextBalance);setAllowance(nextAllowance);
    return {balance:nextBalance,allowance:nextAllowance};
  }

  async function checkPending(item:PendingTx) {
    if(checking.current)return;
    checking.current=true;
    try {
    const current=await load();
    const ethereum=await activeWallet(current.config);
    const receipt=await ethereum.request({method:'eth_getTransactionReceipt',params:[item.hash]}) as {status?:string}|null;
    if(!receipt) {
      if(await actionComplete(item,current)) {
        savePending(null);setIssue(null);await onChanged();onNotice(`${actionLabels[item.action]} 상태가 체인에서 확인되었습니다.`);return;
      }
      const tx=await ethereum.request({method:'eth_getTransactionByHash',params:[item.hash]}) as {nonce?:string;from?:string}|null;
      const nonce=item.nonce||((tx?.from?.toLowerCase()===wallet.toLowerCase()&&tx.nonce)?tx.nonce:undefined);
      if(nonce&&!item.nonce)savePending({...item,nonce});
      if(nonce) {
        const latest=await ethereum.request({method:'eth_getTransactionCount',params:[wallet,'latest']}) as string;
        if(BigInt(latest)>BigInt(nonce)) {
          savePending(null);
          setIssue({message:`${actionLabels[item.action]} 거래가 같은 nonce의 다른 거래로 교체되거나 취소되었습니다. 현재 상태를 확인한 뒤 다시 시도하세요.`,action:item.action,hash:item.hash});
          await onChanged();return;
        }
      }
      const delayed=Date.now()-item.submittedAt>=120_000;
      setIssue({message:delayed?'거래 확인이 2분 이상 지연되고 있습니다. 지갑에서 거래 속도를 높이거나 취소한 뒤 여기서 다시 확인하세요. 처리 여부가 확인될 때까지 같은 작업을 다시 보내지 마세요.':'거래가 아직 확인되지 않았습니다. 같은 작업을 다시 보내기 전에 거래 상태를 확인하세요.',hash:item.hash});
      return;
    }
    if(receipt.status!=='0x1') {
      savePending(null);
      setIssue({message:`${actionLabels[item.action]} 거래가 체인에서 실패했습니다. 현재 상태를 확인한 뒤 다시 시도하세요.`,action:item.action,hash:item.hash});
      await onChanged();
      return;
    }
    const refreshed=await load();
    await readFunds(refreshed).catch(()=>null);
    await onChanged();
    const confirmed=await actionComplete(item,refreshed);
    if(confirmed) {
      savePending(null);setIssue(null);
      onNotice(`${actionLabels[item.action]} 거래가 확인되었습니다.`);
    } else setIssue({message:'거래는 블록에 포함됐고 계약 이벤트 확인을 기다리고 있습니다. 상태를 다시 확인하세요.',hash:item.hash});
    } finally {checking.current=false;}
  }

  async function previewWalletTx(current:Detail,action:WalletAction) {
    const ethereum=await activeWallet(current.config);
    const {to,data}=walletTransaction(current,action,role);
    let gasHex:unknown;
    let priceHex:unknown;
    try {
      [gasHex,priceHex]=await Promise.all([
        ethereum.request({method:'eth_estimateGas',params:[{from:wallet,to,data}]}),
        ethereum.request({method:'eth_gasPrice'}),
      ]);
    } catch {throw new Error('가스비를 계산하지 못했습니다. 체인 상태를 확인한 뒤 다시 시도하세요.');}
    if(typeof gasHex!=='string'||typeof priceHex!=='string'||!/^0x[0-9a-fA-F]+$/.test(gasHex)||!/^0x[0-9a-fA-F]+$/.test(priceHex)) throw new Error('가스비 견적을 확인할 수 없습니다.');
    const gas=BigInt(gasHex);
    const gasPrice=BigInt(priceHex);
    if(gas===0n||gasPrice===0n) throw new Error('가스비 견적을 확인할 수 없습니다.');
    setGasQuote({action,to,data,gas,gasPrice,quotedAt:Date.now(),orderId:current.chain!.terms.orderId});
  }

  async function sendWalletTx(current:Detail,quote:GasQuote) {
    if(!canSend(current.chain,quote.action,role)) throw new Error('주문 상태가 바뀌었습니다. 가스비를 다시 확인하세요.');
    if(Date.now()-quote.quotedAt>60_000) throw new Error('가스비 견적이 만료되었습니다. 다시 확인하세요.');
    const ethereum=await activeWallet(current.config);
    const transaction=walletTransaction(current,quote.action,role);
    if(current.chain?.terms.orderId!==quote.orderId||transaction.to!==quote.to||transaction.data!==quote.data) throw new Error('거래 약정이 바뀌었습니다. 가스비를 다시 확인하세요.');
    const hash=await ethereum.request({method:'eth_sendTransaction',params:[{from:wallet,to:quote.to,data:quote.data}]}) as string;
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error('지갑이 유효한 거래 해시를 반환하지 않았습니다.');
    const item:PendingTx={action:quote.action,hash,submittedAt:Date.now()};
    savePending(item);
    setIssue({message:'거래를 전송했습니다. 블록과 계약 이벤트 확인을 기다립니다.',hash});
    if(quote.action==='open') await jsonPost(path,{action:'tx',txAction:quote.action,hash}).catch(()=>{});
    await checkPending(item);
  }

  async function confirmGasQuote() {
    if(!gasQuote||working||pending)return;
    setWorking(true);setIssue(null);
    try {await sendWalletTx(await load(),gasQuote);}
    catch(error) {const message=walletError(error);setGasQuote(null);setIssue({message,action:gasQuote.action});onNotice(message);await load().catch(()=>{});}
    finally {setWorking(false);}
  }

  async function act(action:'prepare'|'sign'|'release'|'approve'|'open'|'maker'|'taker'|'cancel'|'expire'|'refund') {
    if(working||pending)return;setWorking(true);setIssue(null);
    try {
      if(action==='prepare') {await jsonPost(path,{action});const next=await load();await onChanged();onNotice('로컬 체인 약정을 준비했습니다. 양측 지갑 서명이 필요합니다.');if(next.chain)await readFunds(next).catch(()=>{});}
      else if(action==='sign') {
        if(!detail?.chain) throw new Error('체인 주문이 없습니다.');
        const ethereum=await activeWallet(detail.config);
        const typed=typedOrder(detail.config.chainId,detail.config.contract,detail.chain.terms);
        const signature=await ethereum.request({method:'eth_signTypedData_v4',params:[wallet,JSON.stringify(typed,(_key,value)=>typeof value==='bigint'?value.toString():value)]});
        await jsonPost(path,{action,signature});await load();onNotice('약정 서명을 저장했습니다. 예치 트랜잭션과는 별개입니다.');
      } else if(action==='release') {await jsonPost(path,{action});await load();await onChanged();onNotice('서명 만료를 체인에서 확인하고 광고 재고를 복구했습니다.');}
      else {
        const latest=await load();
        if(!canSend(latest.chain,action,role)) throw new Error('주문 상태가 바뀌었습니다. 현재 버튼을 확인하세요.');
        await previewWalletTx(latest,action);
      }
    } catch(error) {const message=walletError(error);setIssue({message,action:['approve','open','maker','taker','cancel','expire','refund'].includes(action)?action as WalletAction:undefined});onNotice(message);await load().catch(()=>{});} finally {setWorking(false);}
  }

  if(!enabled)return null;
  const chain=detail?.chain;
  const ownSignature=role==='maker'?chain?.maker_signature:chain?.taker_signature;
  const bothSigned=!!chain?.maker_signature&&!!chain?.taker_signature;
  const depositAmount=chain?BigInt(role==='maker'?chain.terms.makerDeposit:chain.terms.takerDeposit):0n;
  const token=chain?(role==='maker'?chain.terms.makerToken:chain.terms.takerToken):null;
  const decimals=token?.toLowerCase()===detail?.config.usdc.toLowerCase()?6:18;
  const tokenName=(address:Address)=>address.toLowerCase()===detail?.config.usdc.toLowerCase()?'USDC':'WETH';
  const amountLabel=(value:string,address:Address)=>`${formatUnits(BigInt(value),tokenName(address)==='USDC'?6:18)} ${tokenName(address)}`;
  const deadline=chain?depositDeadline(chain):0;
  const deadlinePassed=deadline>0&&Date.now()/1000>deadline;
  const depositing=(chain?.state==='OPEN'&&role==='maker'||chain?.state==='MAKER_FUNDED'&&role==='taker')&&!deadlinePassed;
  const signaturePassed=chain&&Date.now()/1000>Number(chain.terms.signatureDeadline);
  const blocked=working||!!pending;
  const walletBlocked=blocked||!!walletIssue;
  return <div className="chain-panel"><button className="chain-toggle" onClick={()=>{setOpen(value=>!value);setGasQuote(null);}}>{open?'로컬 체인 닫기':'로컬 체인 거래'}</button>{open&&<div className="chain-content"><p>로컬 Anvil 테스트 토큰만 사용합니다. Sepolia에서 로그인한 지갑을 거래 전 31337로 전환하세요. 에스크로 {detail?.config.contract.slice(0,10)}…</p>
    {walletIssue&&<p className="chain-recovery" role="status">{walletIssue}</p>}
    {pending&&<div className="chain-recovery" role="status"><strong>{actionLabels[pending.action]} 거래 확인 중</strong><p>거래 {pending.hash}</p>{pending.nonce&&<p>nonce {BigInt(pending.nonce).toString()}</p>}<button onClick={()=>void checkPending(pending).catch(error=>setIssue({message:walletError(error),hash:pending.hash}))}>거래 다시 확인</button></div>}
    {issue&&<div className="chain-recovery chain-error" role="alert"><p>{issue.message}</p>{issue.hash&&<p>거래 {issue.hash}</p>}{!pending&&issue.action&&<button disabled={working} onClick={()=>void act(issue.action!)}>상태 확인 후 다시 시도</button>}</div>}
    {gasQuote&&!pending&&<div className="chain-gas-preview" role="status"><strong>{actionLabels[gasQuote.action]} 가스비 견적</strong><p>예상 사용량 {gasQuote.gas.toLocaleString()} gas · 현재 단가 {formatUnits(gasQuote.gasPrice,9)} Gwei</p><p>예상 네트워크 비용 약 {formatEther(gasQuote.gas*gasQuote.gasPrice)} ETH</p><p>견적은 1분간 유효하며 실제 가스비는 달라질 수 있습니다. 지갑에서 최종 금액을 확인하세요.</p><button disabled={walletBlocked} onClick={()=>void confirmGasQuote()}>지갑에서 계속</button><button disabled={working} onClick={()=>setGasQuote(null)}>취소</button></div>}
    {!chain?<>{role==='taker'?<button disabled={blocked} onClick={()=>void act('prepare')}>수락한 주문을 체인 거래로 전환</button>:<p>거래자가 체인 거래를 준비하면 서명할 수 있습니다.</p>}</>:<>
      <p><strong>{chainLabels[chain.state]||chain.state}</strong> · 주문 {chain.terms.orderId.slice(0,10)}…</p>
      <p>서명 기한 {new Date(Number(chain.terms.signatureDeadline)*1000).toLocaleString('ko-KR')} · Maker {chain.maker_signature?'서명 완료':'대기'} / Taker {chain.taker_signature?'서명 완료':'대기'}</p>
      <dl className="chain-terms"><div><dt>Maker</dt><dd>{chain.terms.maker}</dd></div><div><dt>Taker</dt><dd>{chain.terms.taker}</dd></div><div><dt>Maker 예치 → 수취</dt><dd>{amountLabel(chain.terms.makerDeposit,chain.terms.makerToken)} → {amountLabel(chain.terms.makerReceive,chain.terms.takerToken)}</dd></div><div><dt>Taker 예치 → 수취</dt><dd>{amountLabel(chain.terms.takerDeposit,chain.terms.takerToken)} → {amountLabel(chain.terms.takerReceive,chain.terms.makerToken)}</dd></div><div><dt>수수료</dt><dd>{formatUnits(BigInt(chain.terms.fee),6)} USDC</dd></div><div><dt>토큰 주소</dt><dd>USDC {detail?.config.usdc}<br/>WETH {detail?.config.weth}</dd></div></dl>
      {chain.state==='CHAIN_SIGNING'&&!ownSignature&&!signaturePassed&&<button disabled={walletBlocked} onClick={()=>void act('sign')}>고정 약정 지갑 서명</button>}
      {(chain.state==='CHAIN_SIGNING'||chain.state==='OPEN_PENDING')&&bothSigned&&!signaturePassed&&<button disabled={walletBlocked} onClick={()=>void act('open')}>에스크로 개설 트랜잭션</button>}
      {(chain.state==='CHAIN_SIGNING'||chain.state==='OPEN_PENDING')&&signaturePassed&&<button disabled={blocked} onClick={()=>void act('release')}>서명 만료 확인·재고 복구</button>}
      {depositing&&<div className="chain-deposit"><p>내 예치량 {formatUnits(depositAmount,decimals)} {decimals===6?'USDC':'WETH'} · 잔액 {balance===null?'확인 중':formatUnits(balance,decimals)} · 승인 {allowance===null?'확인 중':formatUnits(allowance,decimals)}</p>{allowance!==null&&allowance<depositAmount?<button disabled={walletBlocked} onClick={()=>void act('approve')}>정확한 수량 승인</button>:<button disabled={walletBlocked||balance===null||balance<depositAmount} onClick={()=>void act(role)}>지갑에서 예치{role==='taker'?'·즉시 정산':''}</button>}</div>}
      {chain.state==='OPEN'&&!deadlinePassed&&<button disabled={walletBlocked} onClick={()=>void act('cancel')}>예치 전 취소</button>}
      {chain.state==='OPEN'&&deadlinePassed&&<button disabled={walletBlocked} onClick={()=>void act('expire')}>미예치 만료 처리</button>}
      {chain.state==='MAKER_FUNDED'&&deadlinePassed&&<button disabled={walletBlocked} onClick={()=>void act('refund')}>Maker 자산 환불</button>}
      {chain.events.length>0&&<ol className="order-history">{chain.events.map(event=><li key={`${event.tx_hash}-${event.event_name}`}>{eventLabels[event.event_name]||event.event_name} · 블록 {event.block_number} · 거래 {event.tx_hash.slice(0,12)}…</li>)}</ol>}
      {chain.open_tx&&chain.state==='OPEN_PENDING'&&<p>개설 거래 {chain.open_tx.slice(0,14)}… 확인 대기</p>}
    </>}
    <button onClick={()=>void load().then(onChanged).catch(error=>onNotice(error.message))}>체인 상태 새로고침</button>
  </div>}</div>;
}
