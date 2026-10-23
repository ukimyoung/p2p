import assert from 'node:assert/strict';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { contractTerms, erc20Abi, escrowAbi, typedOrder, type ChainTerms } from '../lib/chain-abi';

const base=process.env.P2P_TEST_BASE_URL||'http://localhost:3011';
const rpc=process.env.P2P_CHAIN_RPC_URL||'http://127.0.0.1:8545/';
const publicClient=createPublicClient({transport:http(rpc)});
const walletClient=createWalletClient({transport:http(rpc)});
const mnemonic='test test test test test test test test test test test junk';
const maker=mnemonicToAccount(mnemonic,{addressIndex:1});
const taker=mnemonicToAccount(mnemonic,{addressIndex:2});
const post=async(path:string,body:unknown,cookie?:string)=>fetch(base+path,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
const get=async(path:string,cookie?:string)=>fetch(base+path,{headers:cookie?{Cookie:cookie}:{}});
async function checked(response:Response,status=200) {
  const data=await response.json();
  assert.equal(response.status,status,JSON.stringify(data));
  return data;
}
async function login(account:typeof maker) {
  const challenge=await checked(await post('/api/v1/auth/challenge',{address:account.address,chainId:11155111}));
  const signature=await account.signMessage({message:challenge.message});
  const response=await post('/api/v1/auth/verify',{message:challenge.message,signature});
  await checked(response);
  const cookie=response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}
async function tx(account:typeof maker,address:Address,abi:typeof escrowAbi|typeof erc20Abi,functionName:string,args:unknown[]) {
  const hash=await walletClient.writeContract({account,chain:null,address,abi,functionName,args} as Parameters<typeof walletClient.writeContract>[0]);
  const receipt=await publicClient.waitForTransactionReceipt({hash});
  assert.equal(receipt.status,'success');
  return hash;
}
async function main() {
  assert.equal(await publicClient.getChainId(),31337);
  const config=await checked(await get('/api/v1/chain/config'));
  assert.equal(config.enabled,true);
  const {contract,usdc,weth}=config.config as {contract:Address;usdc:Address;weth:Address};
  const makerCookie=await login(maker);
  const takerCookie=await login(taker);
  const ad=await checked(await post('/api/v1/ads',{side:'buy',asset:'ETH',price:'2500',total:'1',min:'100',max:'1500',minutes:15,validHours:24},makerCookie),201);
  const adId=ad.ad.id as string;
  const reserve=await checked(await fetch(base+'/api/v1/orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:takerCookie,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({adId,amount:'1000'})}),201);
  const id=reserve.order.id as string;
  await checked(await post(`/api/v1/orders/${id}/respond`,{decision:'accept'},makerCookie));
  const path=`/api/v1/orders/${id}/chain`;
  assert.equal((await checked(await get(path,makerCookie))).chain,null);
  assert.equal((await post(path,{action:'prepare'},makerCookie)).status,404);
  const prepared=await checked(await post(path,{action:'prepare'},takerCookie));
  assert.equal(prepared.chain.state,'CHAIN_SIGNING');
  const terms=prepared.chain.terms as ChainTerms;
  const typed=typedOrder(31337,contract,terms);
  const makerSig=await maker.signTypedData(typed);
  const takerSig=await taker.signTypedData(typed);
  assert.equal((await post(path,{action:'sign',signature:makerSig},takerCookie)).status,401);
  await checked(await post(path,{action:'sign',signature:makerSig},makerCookie));
  await checked(await post(path,{action:'sign',signature:takerSig},takerCookie));
  const openHash=await tx(taker,contract,escrowAbi,'openOrder',[contractTerms(terms),makerSig,takerSig]);
  await checked(await post(path,{action:'tx',txAction:'open',hash:openHash},takerCookie));
  const opened=await checked(await get(path,takerCookie));
  assert.equal(opened.chain.state,'OPEN');
  assert.equal(opened.chain.events[0].event_name,'OrderOpened');
  assert.equal((await checked(await get(`/api/v1/orders/${id}`,takerCookie))).order.state,'OPEN');
  await tx(maker,weth,erc20Abi,'approve',[contract,BigInt(terms.makerDeposit)]);
  await tx(maker,contract,escrowAbi,'depositMaker',[terms.orderId]);
  const funded=await checked(await get(path,makerCookie));
  assert.equal(funded.chain.state,'MAKER_FUNDED');
  const snapshot=await publicClient.request({method:'evm_snapshot' as never,params:[] as never}) as string;
  await tx(taker,usdc,erc20Abi,'approve',[contract,BigInt(terms.takerDeposit)]);
  await tx(taker,contract,escrowAbi,'depositTaker',[terms.orderId]);
  const settled=await checked(await get(path,takerCookie));
  assert.equal(settled.chain.state,'SETTLED');
  assert.deepEqual(settled.chain.events.map((event:{event_name:string})=>event.event_name),['OrderOpened','MakerDeposited','OrderSettled']);
  const settledAd=await checked(await get('/api/v1/me/ads',makerCookie));
  const finalAd=settledAd.ads.find((item:{id:string})=>item.id===adId);
  assert.equal(finalAd.total,'0.6');
  assert.equal(finalAd.available,'0.6');
  assert.equal(await publicClient.request({method:'evm_revert' as never,params:[snapshot] as never}),true);
  const reverted=await checked(await get(path,takerCookie));
  assert.equal(reverted.chain.state,'MAKER_FUNDED');
  assert.equal(reverted.chain.events.length,2);
  const revertedAd=await checked(await get('/api/v1/me/ads',makerCookie));
  const restored=revertedAd.ads.find((item:{id:string})=>item.id===adId);
  assert.equal(restored.total,'1');
  assert.equal(restored.available,'0.6');
  await tx(taker,usdc,erc20Abi,'approve',[contract,BigInt(terms.takerDeposit)]);
  await tx(taker,contract,escrowAbi,'depositTaker',[terms.orderId]);
  assert.equal((await checked(await get(path,takerCookie))).chain.state,'SETTLED');
  async function acceptedOrder() {
    const result=await checked(await fetch(base+'/api/v1/orders',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:takerCookie,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({adId,amount:'100'})}),201);
    await checked(await post(`/api/v1/orders/${result.order.id}/respond`,{decision:'accept'},makerCookie));
    return `/api/v1/orders/${result.order.id}/chain`;
  }
  async function openedOrder() {
    const orderPath=await acceptedOrder();
    const preparedOrder=await checked(await post(orderPath,{action:'prepare'},takerCookie));
    const orderTerms=preparedOrder.chain.terms as ChainTerms;
    const orderTyped=typedOrder(31337,contract,orderTerms);
    const makerSignature=await maker.signTypedData(orderTyped);
    const takerSignature=await taker.signTypedData(orderTyped);
    await checked(await post(orderPath,{action:'sign',signature:makerSignature},makerCookie));
    await checked(await post(orderPath,{action:'sign',signature:takerSignature},takerCookie));
    await tx(taker,contract,escrowAbi,'openOrder',[contractTerms(orderTerms),makerSignature,takerSignature]);
    assert.equal((await checked(await get(orderPath,takerCookie))).chain.state,'OPEN');
    return {orderPath,orderTerms};
  }
  const cancelledOrder=await openedOrder();
  await tx(taker,contract,escrowAbi,'cancelUnfunded',[cancelledOrder.orderTerms.orderId]);
  assert.equal((await checked(await get(cancelledOrder.orderPath,takerCookie))).chain.state,'CANCELLED');
  const refundable=await openedOrder();
  await tx(maker,weth,erc20Abi,'approve',[contract,BigInt(refundable.orderTerms.makerDeposit)]);
  await tx(maker,contract,escrowAbi,'depositMaker',[refundable.orderTerms.orderId]);
  assert.equal((await checked(await get(refundable.orderPath,makerCookie))).chain.state,'MAKER_FUNDED');
  const secondPath=await acceptedOrder();
  const pending=await checked(await post(secondPath,{action:'prepare'},takerCookie));
  assert.equal((await post(secondPath,{action:'release'},takerCookie)).status,409);
  assert.ok(Number(pending.chain.terms.signatureDeadline)>0);
  await publicClient.request({method:'evm_increaseTime' as never,params:[901] as never});
  await publicClient.request({method:'evm_mine' as never,params:[] as never});
  await tx(taker,contract,escrowAbi,'refundMaker',[refundable.orderTerms.orderId]);
  assert.equal((await checked(await get(refundable.orderPath,makerCookie))).chain.state,'REFUNDED');
  const released=await checked(await post(secondPath,{action:'release'},takerCookie));
  assert.equal(released.chain.state,'SIGNATURE_EXPIRED');
  assert.equal((await checked(await get(secondPath,makerCookie))).chain.state,'SIGNATURE_EXPIRED');
  const releasedAd=await checked(await get('/api/v1/me/ads',makerCookie));
  assert.equal(releasedAd.ads.find((item:{id:string})=>item.id===adId).available,'0.6');
  const miningClient=createPublicClient({transport:http(rpc,{timeout:180_000,retryCount:0})});
  await miningClient.request({method:'anvil_mine' as never,params:['0x271a'] as never});
  const afterGap=await checked(await get(path,takerCookie));
  assert.equal(afterGap.chain.state,'SETTLED');
  assert.equal(afterGap.chain.events.length,3);
  console.log('PASS: dual signatures, wallet escrow, settlement/cancellation/refund, confirmed event projection, stock, reorg rollback, expired signature release and >10,000-block catch-up.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
