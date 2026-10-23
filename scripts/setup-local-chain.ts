import { writeFile } from 'node:fs/promises';
import { deployLocalFixture } from './local-chain';

async function main() {
  const fixture=await deployLocalFixture();
  for(const address of fixture.accounts.slice(0,3)) {
    await fixture.mint(fixture.usdc,address,10_000_000_000n);
    await fixture.mint(fixture.weth,address,10n**19n);
  }
  const env=[
    `P2P_CHAIN_RPC_URL=${fixture.rpcUrl}`,
    `P2P_CHAIN_ID=${fixture.chainId}`,
    `P2P_ESCROW_ADDRESS=${fixture.escrow}`,
    `P2P_USDC_ADDRESS=${fixture.usdc}`,
    `P2P_WETH_ADDRESS=${fixture.weth}`,
    `P2P_CHAIN_START_BLOCK=${fixture.startBlock}`,
    'P2P_CHAIN_CONFIRMATIONS=1',
  ].join('\n')+'\n';
  const output=process.env.P2P_CHAIN_ENV_PATH||'.env.local';
  await writeFile(output,env,{flag:'wx',mode:0o600});
  process.stdout.write(`Local contracts deployed and ${output} created. Restart the web server to use the local chain.\n`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
