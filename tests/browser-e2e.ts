import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium, expect, type BrowserContext, type Page } from '@playwright/test';
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { erc20Abi, escrowAbi } from '../lib/chain-abi';

const base=process.env.P2P_TEST_BASE_URL||'http://localhost:3011';
const rpc=process.env.P2P_CHAIN_RPC_URL||'http://127.0.0.1:8545/';
const walletClient=createWalletClient({transport:http(rpc)});
const publicClient=createPublicClient({transport:http(rpc)});
const mnemonic='test test test test test test test test test test test junk';
const maker=mnemonicToAccount(mnemonic,{addressIndex:1});
const taker=mnemonicToAccount(mnemonic,{addressIndex:2});
type Account=typeof maker;
type WalletState={chainId:number;selectedAddress?:Address;rejectTypedOnce:boolean;failEstimateOnce:boolean;failTransactionOnce:boolean;sentTransactions:number};

async function rpcRequest(method:string,params:unknown[]) {
  const response=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
  const body=await response.json() as {result?:unknown;error?:{message:string}};
  if(body.error)throw new Error(body.error.message);
  return body.result;
}

async function installWallet(context:BrowserContext,account:Account,state:WalletState,escrow:Address) {
  await context.exposeBinding('__p2pWalletRequest',async(_source,request:{method:string;params?:unknown[]})=>{
    const params=request.params||[];
    if(request.method==='eth_requestAccounts'||request.method==='eth_accounts')return [state.selectedAddress||account.address];
    if(request.method==='eth_chainId')return `0x${state.chainId.toString(16)}`;
    if(request.method==='personal_sign')return account.signMessage({message:params[0] as string});
    if(request.method==='eth_signTypedData_v4') {
      if(state.rejectTypedOnce){state.rejectTypedOnce=false;throw new Error('User rejected the request');}
      const typed=JSON.parse(params[1] as string);
      for(const key of ['makerNonce','takerNonce','makerDeposit','takerDeposit','makerReceive','takerReceive','fee','signatureDeadline'])typed.message[key]=BigInt(typed.message[key]);
      return account.signTypedData(typed);
    }
    if(request.method==='eth_estimateGas'&&state.failEstimateOnce){state.failEstimateOnce=false;throw new Error('Gas estimate unavailable');}
    if(['eth_call','eth_estimateGas','eth_gasPrice'].includes(request.method))return rpcRequest(request.method,params);
    if(['eth_getTransactionReceipt','eth_getTransactionByHash','eth_getTransactionCount'].includes(request.method))return rpcRequest(request.method,params);
    if(request.method==='eth_sendTransaction') {
      state.sentTransactions++;
      const tx=params[0] as {from:Address;to:Address;data:Hex};
      assert.equal(tx.from.toLowerCase(),account.address.toLowerCase());
      if(state.failTransactionOnce){
        state.failTransactionOnce=false;
        const reverting=encodeFunctionData({abi:escrowAbi,functionName:'depositMaker',args:[`0x${'00'.repeat(32)}`]});
        return walletClient.sendTransaction({account,chain:null,to:escrow,data:reverting,gas:300_000n});
      }
      return walletClient.sendTransaction({account,chain:null,to:tx.to,data:tx.data});
    }
    throw new Error(`Unexpected wallet method: ${request.method}`);
  });
  await context.addInitScript({content:`(() => {const listeners = new Map();window.__p2pWalletEmit = (event, value) => {for (const listener of listeners.get(event) || []) listener(value);};window.ethereum = {request: (request) => window.__p2pWalletRequest(request),on: (event, listener) => {if (!listeners.has(event)) listeners.set(event, new Set());listeners.get(event).add(listener);},removeListener: (event, listener) => listeners.get(event)?.delete(listener)};})();`});
}

async function login(page:Page,account:Account,state:WalletState) {
  await page.goto(base);
  await page.waitForLoadState('networkidle');
  await page.getByRole('button',{name:/지갑 로그인/}).click();
  try {await expect(page.locator('.wallet')).toContainText(account.address.slice(0,6));}
  catch(error) {console.error('Wallet login feedback:',await page.locator('.toast').allTextContents(),'provider:',await page.evaluate(()=>typeof (window as Window & {ethereum?:unknown}).ethereum));throw error;}
  state.chainId=31337;
}
async function confirmGas(page:Page) {
  await expect(page.locator('.chain-gas-preview')).toContainText('예상 네트워크 비용');
  await page.locator('.chain-gas-preview').getByRole('button',{name:'지갑에서 계속'}).click();
}

async function main() {
  assert.equal(await rpcRequest('eth_chainId',[]),'0x7a69');
  const config=await (await fetch(`${base}/api/v1/chain/config`)).json() as {enabled:boolean;config:{contract:Address;usdc:Address;weth:Address}};
  assert.equal(config.enabled,true);
  for(const [account,token] of [[maker,config.config.weth],[taker,config.config.usdc]] as const) {
    const hash=await walletClient.writeContract({account,chain:null,address:token,abi:erc20Abi,functionName:'approve',args:[config.config.contract,0n]});
    assert.equal((await publicClient.waitForTransactionReceipt({hash})).status,'success');
  }
  const browser=await chromium.launch({headless:true,...(existsSync(process.env.P2P_CHROMIUM_PATH||'/usr/bin/chromium')?{executablePath:process.env.P2P_CHROMIUM_PATH||'/usr/bin/chromium'}:{}),args:['--no-sandbox']});
  try {
    const makerContext=await browser.newContext();
    const takerContext=await browser.newContext();
    const makerState:WalletState={chainId:11155111,rejectTypedOnce:false,failEstimateOnce:false,failTransactionOnce:false,sentTransactions:0};
    const takerState:WalletState={chainId:11155111,rejectTypedOnce:false,failEstimateOnce:false,failTransactionOnce:false,sentTransactions:0};
    await installWallet(makerContext,maker,makerState,config.config.contract);
    await installWallet(takerContext,taker,takerState,config.config.contract);
    const makerPage=await makerContext.newPage();
    const takerPage=await takerContext.newPage();
    makerPage.on('pageerror',error=>console.error('Maker page error:',error));
    takerPage.on('pageerror',error=>console.error('Taker page error:',error));
    await login(makerPage,maker,makerState);
    await makerPage.locator('header').getByRole('button',{name:'내 광고'}).click();
    await makerPage.getByRole('button',{name:'광고 만들기'}).click();
    await makerPage.getByRole('button',{name:'데모 광고 등록'}).click();
    await expect(makerPage.locator('.owned-ad')).toContainText('2500 USDC');

    await login(takerPage,taker,takerState);
    await takerPage.getByLabel('정렬 기준').selectOption('newest');
    await expect(takerPage.locator('tbody tr').first()).toContainText(maker.address.slice(0,6));
    await takerPage.getByLabel('정렬 기준').selectOption('available_desc');
    await expect(takerPage.locator('tbody tr').first()).toContainText('24 ETH');
    await takerPage.getByLabel('정렬 기준').selectOption('best_price');
    const makerRow=takerPage.locator('tr').filter({hasText:maker.address.slice(0,6)});
    await expect(makerRow).toBeVisible();
    await makerRow.getByRole('button',{name:/ETH 구매/}).click();
    await takerPage.getByRole('button',{name:'데모 예약 요청'}).click();
    await takerPage.getByRole('button',{name:'내 예약'}).click();
    await expect(takerPage.locator('.order-list-item')).toContainText('광고주 응답 대기');
    await takerPage.locator('.my-orders .order-status-filters').getByRole('button',{name:'완료 0'}).click();
    await expect(takerPage.locator('.order-list-item')).toHaveCount(0);
    await expect(takerPage.locator('.my-orders')).toContainText('선택한 상태의 데모 예약이 없습니다.');
    await takerPage.locator('.my-orders .order-status-filters').getByRole('button',{name:'진행 중 1'}).click();
    await expect(takerPage.locator('.order-list-item')).toHaveCount(1);
    await makerPage.locator('.incoming-heading').getByRole('button',{name:'새로고침'}).click();
    await makerPage.locator('.incoming-orders .order-status-filters').getByRole('button',{name:'완료 0'}).click();
    await expect(makerPage.locator('.incoming-item')).toHaveCount(0);
    await makerPage.locator('.incoming-orders .order-status-filters').getByRole('button',{name:'진행 중 1'}).click();
    await makerPage.locator('.incoming-item').getByRole('button',{name:'수락'}).click();
    await expect(makerPage.locator('.incoming-item')).toContainText('광고주 수락');
    await takerPage.getByRole('button',{name:'새로고침'}).click();
    await expect(takerPage.locator('.order-list-item')).toContainText('광고주 수락');
    await takerPage.locator('.order-list-item').getByRole('button',{name:'상태 이력'}).click();
    await expect(takerPage.locator('.order-timeline')).toContainText('나');
    await expect(takerPage.locator('.order-timeline')).toContainText('상대방');
    await takerPage.locator('.order-conversation').getByRole('button',{name:'대화 보기'}).click();
    await takerPage.locator('.order-conversation').getByRole('textbox',{name:'메시지'}).fill('거래 조건을 확인했습니다.');
    await takerPage.locator('.order-conversation').getByRole('button',{name:'메시지 보내기'}).click();
    await makerPage.locator('.order-conversation').getByRole('button',{name:'대화 보기'}).click();
    await expect(makerPage.locator('.order-conversation')).toContainText('거래 조건을 확인했습니다.');
    await makerPage.locator('.order-conversation').getByRole('textbox',{name:'메시지'}).fill('확인했습니다.');
    await makerPage.locator('.order-conversation').getByRole('button',{name:'메시지 보내기'}).click();
    await expect(takerPage.locator('.order-conversation')).toContainText('확인했습니다.');
    await takerPage.locator('.order-safety').getByRole('button',{name:'신고·차단'}).click();
    await takerPage.locator('.order-safety').getByRole('textbox',{name:'신고 내용'}).fill('반복적인 스팸 메시지를 보냈습니다.');
    await takerPage.locator('.order-safety').getByRole('button',{name:'신고 접수'}).click();
    await expect(takerPage.locator('.order-safety')).toContainText('신고 접수됨 · 검토 대기');
    await takerPage.locator('.order-safety').getByRole('button',{name:'상대방 차단'}).click();
    await expect(takerPage.locator('.order-safety').getByRole('button',{name:'차단 해제'})).toBeVisible();
    await expect(makerRow).toHaveCount(0);
    await takerPage.getByRole('button',{name:'로컬 체인 거래'}).click();
    await takerPage.getByRole('button',{name:'수락한 주문을 체인 거래로 전환'}).click();
    await expect(takerPage.locator('.chain-panel')).toContainText('두 지갑 서명 대기');

    await makerPage.locator('.incoming-heading').getByRole('button',{name:'새로고침'}).click();
    await makerPage.getByRole('button',{name:'로컬 체인 거래'}).click();
    makerState.rejectTypedOnce=true;
    await makerPage.getByRole('button',{name:'고정 약정 지갑 서명'}).click();
    await expect(makerPage.locator('.chain-error')).toContainText('지갑에서 요청을 취소');
    await makerPage.getByRole('button',{name:'고정 약정 지갑 서명'}).click();
    await expect(makerPage.locator('.chain-panel')).toContainText('Maker 서명 완료');
    await takerPage.getByRole('button',{name:'고정 약정 지갑 서명'}).click();
    await expect(takerPage.locator('.chain-panel')).toContainText('Taker 서명 완료');
    takerState.failEstimateOnce=true;
    await takerPage.getByRole('button',{name:'에스크로 개설 트랜잭션'}).click();
    await expect(takerPage.locator('.chain-error')).toContainText('가스비를 계산하지 못했습니다');
    assert.equal(takerState.sentTransactions,0);
    takerState.failTransactionOnce=true;
    await takerPage.getByRole('button',{name:'에스크로 개설 트랜잭션'}).click();
    await confirmGas(takerPage);
    await expect(takerPage.locator('.chain-error')).toContainText('체인에서 실패');
    await takerPage.getByRole('button',{name:'상태 확인 후 다시 시도'}).click();
    await confirmGas(takerPage);
    await expect(takerPage.locator('.chain-panel')).toContainText('Maker 예치 대기');

    await makerPage.locator('.chain-content').getByRole('button',{name:'체인 상태 새로고침'}).click();
    await expect(makerPage.getByRole('button',{name:'정확한 수량 승인'})).toBeVisible();
    makerState.chainId=11155111;
    await makerPage.evaluate(()=>(window as unknown as {__p2pWalletEmit:(event:string,value:unknown)=>void}).__p2pWalletEmit('chainChanged','0xaa36a7'));
    await expect(makerPage.locator('.chain-content')).toContainText('로컬 Anvil 체인(31337)으로 전환');
    await expect(makerPage.locator('.chain-deposit button')).toBeDisabled();
    makerState.chainId=31337;
    await makerPage.evaluate(()=>(window as unknown as {__p2pWalletEmit:(event:string,value:unknown)=>void}).__p2pWalletEmit('chainChanged','0x7a69'));
    await expect(makerPage.locator('.chain-deposit button',{hasText:'정확한 수량 승인'})).toBeEnabled({timeout:15_000});
    await rpcRequest('anvil_setAutomine',[false]);
    await makerPage.getByRole('button',{name:'정확한 수량 승인'}).click();
    await confirmGas(makerPage);
    await expect(makerPage.locator('div.chain-recovery[role="status"]')).toContainText('거래 확인 중');
    await expect(makerPage.getByRole('button',{name:'정확한 수량 승인'})).toBeDisabled();
    await expect(makerPage.locator('div.chain-recovery[role="status"]')).toContainText('nonce');
    const sentBeforeReload=makerState.sentTransactions;
    await makerPage.evaluate(()=>{for(const key of Object.keys(localStorage)){if(key.startsWith('peer:pending:')){const item=JSON.parse(localStorage.getItem(key)!);item.submittedAt=Date.now()-121_000;localStorage.setItem(key,JSON.stringify(item));}}});
    await makerPage.reload();
    await makerPage.waitForLoadState('networkidle');
    await makerPage.locator('header').getByRole('button',{name:'내 광고'}).click();
    await makerPage.getByRole('button',{name:'로컬 체인 거래'}).click();
    await expect(makerPage.locator('div.chain-recovery[role="status"]')).toContainText('거래 확인 중');
    await expect(makerPage.locator('.chain-error')).toContainText('2분 이상 지연');
    assert.equal(makerState.sentTransactions,sentBeforeReload);
    const pendingHash=(await makerPage.locator('div.chain-recovery[role="status"]').textContent())!.match(/0x[0-9a-fA-F]{64}/)![0];
    const pendingTx=await rpcRequest('eth_getTransactionByHash',[pendingHash]) as {nonce:string};
    await rpcRequest('anvil_dropTransaction',[pendingHash]);
    await rpcRequest('anvil_setAutomine',[true]);
    const cancelHash=await walletClient.sendTransaction({account:maker,chain:null,to:maker.address,value:0n,nonce:Number(BigInt(pendingTx.nonce)),gas:21_000n});
    assert.equal((await publicClient.waitForTransactionReceipt({hash:cancelHash})).status,'success');
    await makerPage.getByRole('button',{name:'거래 다시 확인'}).click();
    await expect(makerPage.locator('.chain-error')).toContainText('교체되거나 취소');
    await makerPage.getByRole('button',{name:'상태 확인 후 다시 시도'}).click();
    await confirmGas(makerPage);
    await expect(makerPage.getByRole('button',{name:'지갑에서 예치'})).toBeEnabled();
    await makerPage.getByRole('button',{name:'지갑에서 예치'}).click();
    await confirmGas(makerPage);
    await expect(makerPage.locator('.chain-panel')).toContainText('Taker 예치 대기');
    await takerPage.locator('.chain-content').getByRole('button',{name:'체인 상태 새로고침'}).click();
    await expect(takerPage.getByRole('button',{name:'정확한 수량 승인'})).toBeVisible();
    await takerPage.getByRole('button',{name:'정확한 수량 승인'}).click();
    await confirmGas(takerPage);
    await expect(takerPage.getByRole('button',{name:'지갑에서 예치·즉시 정산'})).toBeEnabled();
    await takerPage.locator('.my-orders .order-status-filters').getByRole('button',{name:'전체 1'}).click();
    await takerPage.getByRole('button',{name:'지갑에서 예치·즉시 정산'}).click();
    await confirmGas(takerPage);
    await expect(takerPage.locator('.chain-panel')).toContainText('교환 완료');
    await expect(takerPage.locator('.order-conversation')).toContainText('종료된 주문은 읽기만 가능합니다.');
    await takerPage.getByRole('button',{name:'새로고침',exact:true}).click();
    await takerPage.locator('.my-orders .order-status-filters').getByRole('button',{name:'진행 중 0'}).click();
    await expect(takerPage.locator('.order-list-item')).toHaveCount(0);
    await takerPage.locator('.my-orders .order-status-filters').getByRole('button',{name:'완료 1'}).click();
    await expect(takerPage.locator('.order-list-item')).toContainText('교환 완료');
    const order=await (await takerPage.request.get(`${base}/api/v1/orders`)).json() as {orders:Array<{state:string}>};
    assert.equal(order.orders[0].state,'SETTLED');
    makerState.selectedAddress=taker.address;
    await makerPage.evaluate(address=>(window as unknown as {__p2pWalletEmit:(event:string,value:unknown)=>void}).__p2pWalletEmit('accountsChanged',[address]),taker.address);
    await expect(makerPage.locator('.wallet')).toContainText('지갑 로그인');
    await expect(makerPage.locator('.toast')).toContainText('지갑 계정이 변경되어');
    assert.equal((await makerPage.request.get(`${base}/api/v1/auth/me`)).status(),401);
    console.log('PASS: two browser wallets, SIWE, participant conversation, report/block with existing order recovery, delayed transaction recovery, approvals, deposits and settlement.');
  } finally {await rpcRequest('anvil_setAutomine',[true]).catch(()=>{});await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
