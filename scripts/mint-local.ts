import { createPublicClient, createWalletClient, getAddress, http, isAddress, type Address } from 'viem';

async function main() {
  const target=process.argv[2];
  if(!target||!isAddress(target)) throw new Error('Usage: npm run chain:mint -- 0xYourTestWallet');
  const rpc=process.env.P2P_CHAIN_RPC_URL;
  const usdc=process.env.P2P_USDC_ADDRESS;
  const weth=process.env.P2P_WETH_ADDRESS;
  if(!rpc||!['127.0.0.1','localhost'].includes(new URL(rpc).hostname)||!usdc||!weth||!isAddress(usdc)||!isAddress(weth)) throw new Error('Load the local chain environment file first.');
  const transport=http(rpc);
  const client=createPublicClient({transport});
  if(await client.getChainId()!==31337) throw new Error('Minting is limited to local Anvil 31337.');
  const wallet=createWalletClient({transport});
  const admin=(await wallet.getAddresses())[0];
  if(!admin) throw new Error('Anvil has no unlocked account.');
  const abi=[{type:'function',name:'mint',stateMutability:'nonpayable',inputs:[{type:'address'},{type:'uint256'}],outputs:[]}] as const;
  for(const [token,amount] of [[usdc,10_000_000_000n],[weth,10n**19n]] as const) {
    if(!await client.getCode({address:token as Address})) throw new Error('Local token contract is missing.');
    const hash=await wallet.writeContract({account:admin,chain:null,address:token as Address,abi,functionName:'mint',args:[getAddress(target),amount]});
    const receipt=await client.waitForTransactionReceipt({hash});
    if(receipt.status!=='success') throw new Error('Local mint transaction failed.');
  }
  const gasHash=await wallet.sendTransaction({account:admin,chain:null,to:getAddress(target),value:10n**18n});
  if((await client.waitForTransactionReceipt({hash:gasHash})).status!=='success') throw new Error('Local gas funding failed.');
  console.log(`Minted local test USDC and WETH and sent 1 test ETH to ${getAddress(target)}.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
