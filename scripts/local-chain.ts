import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, http, type Address, type Hex } from 'viem';

const rpcUrl=process.env.P2P_CHAIN_RPC_URL||'http://127.0.0.1:8545/';
const publicClient=createPublicClient({transport:http(rpcUrl)});
const walletClient=createWalletClient({transport:http(rpcUrl)});

async function artifact(name:string) {
  const data=JSON.parse(await readFile(join(process.cwd(),'contracts','out',`${name}.sol`,`${name}.json`),'utf8'));
  return {abi:data.abi,bytecode:data.bytecode.object as Hex};
}

export async function deployLocalFixture() {
  const chainId=await publicClient.getChainId();
  if(chainId!==31337) throw new Error('Local fixture requires Anvil chain 31337.');
  const accounts=await walletClient.getAddresses();
  if(accounts.length<3) throw new Error('Anvil must expose at least three unlocked accounts.');
  const admin=accounts[0];
  const token=await artifact('DevToken');
  const escrow=await artifact('PeerEscrow');
  async function deploy(abi:typeof token.abi,bytecode:Hex,args:unknown[]) {
    const hash=await walletClient.deployContract({account:admin,chain:null,abi,bytecode,args});
    const receipt=await publicClient.waitForTransactionReceipt({hash});
    if(receipt.status!=='success'||!receipt.contractAddress) throw new Error('Contract deployment failed.');
    return {address:receipt.contractAddress,block:receipt.blockNumber};
  }
  const usdc=await deploy(token.abi,token.bytecode,['Local USDC','USDC',6]);
  const weth=await deploy(token.abi,token.bytecode,['Local Wrapped Ether','WETH',18]);
  const exchange=await deploy(escrow.abi,escrow.bytecode,[usdc.address,weth.address,admin,admin,100]);
  const mintAbi=[{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[]}] as const;
  async function mint(tokenAddress:Address,to:Address,amount:bigint) {
    const hash=await walletClient.writeContract({account:admin,chain:null,address:tokenAddress,abi:mintAbi,functionName:'mint',args:[to,amount]});
    await publicClient.waitForTransactionReceipt({hash});
  }
  return {rpcUrl,chainId,admin,accounts,usdc:usdc.address,weth:weth.address,escrow:exchange.address,startBlock:usdc.block,mint,publicClient,walletClient};
}
