import 'server-only';
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { InputError } from './store';
import { escrowAbi } from './chain-abi';

export type ChainConfig = {chainId:31337;rpcUrl:string;contract:Address;usdc:Address;weth:Address;startBlock:bigint;confirmations:number};

export function getChainConfig():ChainConfig|undefined {
  if(process.env.DATABASE_URL) return undefined;
  const keys=['P2P_CHAIN_RPC_URL','P2P_CHAIN_ID','P2P_ESCROW_ADDRESS','P2P_USDC_ADDRESS','P2P_WETH_ADDRESS','P2P_CHAIN_START_BLOCK'];
  if(keys.every(key=>!process.env[key])) return undefined;
  if(keys.some(key=>!process.env[key])) throw new InputError('로컬 체인 설정이 완전하지 않습니다.',503);
  const url=new URL(process.env.P2P_CHAIN_RPC_URL!);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash) throw new InputError('로컬 RPC 주소가 올바르지 않습니다.',503);
  if(process.env.P2P_CHAIN_ID!=='31337') throw new InputError('현재는 로컬 Anvil 체인(31337)만 지원합니다.',503);
  const addresses=['P2P_ESCROW_ADDRESS','P2P_USDC_ADDRESS','P2P_WETH_ADDRESS'].map(key=>process.env[key]!);
  if(addresses.some(address=>!isAddress(address))) throw new InputError('로컬 컨트랙트 주소가 올바르지 않습니다.',503);
  const start=process.env.P2P_CHAIN_START_BLOCK!;
  if(!/^\d+$/.test(start)) throw new InputError('체인 시작 블록이 올바르지 않습니다.',503);
  const confirmations=Number(process.env.P2P_CHAIN_CONFIRMATIONS||'1');
  if(!Number.isInteger(confirmations)||confirmations<1||confirmations>32) throw new InputError('확인 블록 수는 1~32여야 합니다.',503);
  return {chainId:31337,rpcUrl:url.toString(),contract:getAddress(addresses[0]),usdc:getAddress(addresses[1]),weth:getAddress(addresses[2]),startBlock:BigInt(start),confirmations};
}

export function chainClient(config:ChainConfig) {
  return createPublicClient({transport:http(config.rpcUrl,{timeout:5000,retryCount:0})});
}

export async function verifyChainConfig(config:ChainConfig) {
  const client=chainClient(config);
  const chainId=await client.getChainId();
  if(chainId!==config.chainId) throw new InputError('RPC 체인 ID가 설정과 다릅니다.',503);
  const code=await client.getCode({address:config.contract});
  if(!code||code==='0x') throw new InputError('에스크로 계약을 찾을 수 없습니다.',503);
  const [quote,allowed]=await Promise.all([
    client.readContract({address:config.contract,abi:escrowAbi,functionName:'quoteToken'}),
    client.readContract({address:config.contract,abi:escrowAbi,functionName:'allowedToken',args:[config.weth]}),
  ]);
  if(quote.toLowerCase()!==config.usdc.toLowerCase()||!allowed) throw new InputError('에스크로 토큰 설정이 일치하지 않습니다.',503);
}

export function publicChainConfig(config:ChainConfig) {
  return {chainId:config.chainId,contract:config.contract,usdc:config.usdc,weth:config.weth,confirmations:config.confirmations};
}
