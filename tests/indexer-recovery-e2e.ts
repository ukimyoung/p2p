import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPublicClient, createWalletClient, http, type Address } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { contractTerms, erc20Abi, escrowAbi, typedOrder, type ChainTerms } from '../lib/chain-abi';

const mnemonic = 'test test test test test test test test test test test junk';
const maker = mnemonicToAccount(mnemonic, { addressIndex: 1 });
const taker = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const competitor = mnemonicToAccount(mnemonic, { addressIndex: 3 });
const require = createRequire(import.meta.url);
const directory = mkdtempSync(join(tmpdir(), 'p2p-indexer-recovery-'));
const databasePath = join(directory, 'p2p.sqlite');
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

function start(binary: string, args: string[], env = process.env) {
  const child = spawn(binary, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-4000); };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);
  children.push(child);
  return { child, logs: () => output };
}

async function waitUntil(check: () => Promise<boolean>, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Process exited: ${logs()}`);
    try { if (await check()) return; } catch { /* Service is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Service did not start: ${logs()}`);
}

async function checked(response: Response, status = 200) {
  const data = await response.json();
  assert.equal(response.status, status, JSON.stringify(data));
  return data;
}

async function post(base: string, path: string, body: unknown, cookie?: string, key?: string) {
  return fetch(base + path, {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify(body),
  });
}

async function login(base: string, account: typeof maker) {
  const challenge = await checked(await post(base, '/api/v1/auth/challenge', { address: account.address, chainId: 11155111 }));
  const signature = await account.signMessage({ message: challenge.message });
  const response = await post(base, '/api/v1/auth/verify', { message: challenge.message, signature });
  await checked(response);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie?.startsWith('peer_session='));
  return cookie as string;
}

function projection(adId: string, orderId: string) {
  const database = new DatabaseSync(databasePath);
  try {
    return {
      ad: database.prepare('SELECT total_units,available_units,version FROM ads WHERE id=?').get(adId),
      order: database.prepare('SELECT state FROM orders WHERE id=?').get(orderId),
      chainOrder: database.prepare('SELECT state FROM chain_orders WHERE order_id=?').get(orderId),
      history: database.prepare('SELECT state,actor FROM order_events WHERE order_id=? ORDER BY id').all(orderId),
      events: database.prepare('SELECT tx_hash,log_index,block_number,block_hash,event_name,order_id FROM chain_events WHERE order_id=? ORDER BY block_number,log_index').all(orderId),
      checkpoints: database.prepare('SELECT block_number,block_hash FROM chain_blocks WHERE chain_id=31337 ORDER BY block_number').all(),
    };
  } finally { database.close(); }
}
function withoutCheckpoints({ checkpoints: _checkpoints, ...business }: ReturnType<typeof projection>) { return business; }

async function main() {
  let activeLogs = () => '';
  let rpcProxy: ReturnType<typeof createHttpServer> | undefined;
  let laggingProxy: ReturnType<typeof createHttpServer> | undefined;
  let releaseLagging: (() => void) | undefined;
  let releaseWorkerScan: (() => void) | undefined;
  try {
    const rpcPort = await freePort();
    const proxyPort = await freePort();
    const laggingProxyPort = await freePort();
    const webPort = await freePort();
    const laggingWebPort = await freePort();
    assert.equal(new Set([rpcPort, proxyPort, laggingProxyPort, webPort, laggingWebPort]).size, 5);
    const rpcUrl = `http://127.0.0.1:${rpcPort}/`;
    const proxyUrl = `http://127.0.0.1:${proxyPort}/`;
    const laggingProxyUrl = `http://127.0.0.1:${laggingProxyPort}/`;
    const base = `http://127.0.0.1:${webPort}`;
    const laggingBase = `http://127.0.0.1:${laggingWebPort}`;
    const anvilBinary = require.resolve(`@foundry-rs/anvil-${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}/bin/${process.platform === 'win32' ? 'anvil.exe' : 'anvil'}`);
    const anvil = start(anvilBinary, ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--silent']);
    const publicClient = createPublicClient({ transport: http(rpcUrl) });
    const walletClient = createWalletClient({ transport: http(rpcUrl) });
    await waitUntil(async () => (await publicClient.getChainId()) === 31337, anvil.child, anvil.logs);

    process.env.P2P_CHAIN_RPC_URL = rpcUrl;
    const { deployLocalFixture } = await import('../scripts/local-chain');
    const fixture = await deployLocalFixture();
    for (const address of fixture.accounts.slice(0, 3)) {
      await fixture.mint(fixture.usdc, address, 10_000_000_000n);
      await fixture.mint(fixture.weth, address, 10n ** 19n);
    }
    let rpcAvailable = true;
    rpcProxy = createHttpServer(async (request, response) => {
      if (!rpcAvailable) {
        response.writeHead(503, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Local RPC is temporarily unavailable.' }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const upstream = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Local RPC forwarding failed.' }));
      }
    });
    const proxy = rpcProxy;
    await new Promise<void>((resolve, reject) => {
      proxy.once('error', reject);
      proxy.listen(proxyPort, '127.0.0.1', resolve);
    });
    let pauseLagging = false;
    let blockRequests = 0;
    let markLaggingPaused: () => void = () => {};
    const laggingPaused = new Promise<void>(resolve => { markLaggingPaused = resolve; });
    const laggingRelease = new Promise<void>(resolve => { releaseLagging = resolve; });
    let pauseWorkerScan = false;
    let workerBlockRequests = 0;
    let workerScanHeld = false;
    const workerScanRelease = new Promise<void>(resolve => { releaseWorkerScan = resolve; });
    laggingProxy = createHttpServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const method = (JSON.parse(body.toString()) as { method: string }).method;
        if (pauseLagging && method === 'eth_getBlockByNumber' && ++blockRequests === 3) {
          markLaggingPaused();
          await laggingRelease;
        }
        if (pauseWorkerScan && method === 'eth_getBlockByNumber' && ++workerBlockRequests === 3) {
          workerScanHeld = true;
          await workerScanRelease;
        }
        const upstream = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        response.writeHead(502, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'Local RPC forwarding failed.' }));
      }
    });
    const secondProxy = laggingProxy;
    await new Promise<void>((resolve, reject) => {
      secondProxy.once('error', reject);
      secondProxy.listen(laggingProxyPort, '127.0.0.1', resolve);
    });
    const webEnv = {
      ...process.env,
      P2P_DB_PATH: databasePath,
      P2P_CHAIN_RPC_URL: proxyUrl,
      P2P_CHAIN_ID: '31337',
      P2P_ESCROW_ADDRESS: fixture.escrow,
      P2P_USDC_ADDRESS: fixture.usdc,
      P2P_WETH_ADDRESS: fixture.weth,
      P2P_CHAIN_START_BLOCK: String(fixture.startBlock),
      P2P_CHAIN_CONFIRMATIONS: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    };
    async function server(port = webPort, env = webEnv) {
      const process = start(globalThis.process.execPath, ['node_modules/next/dist/bin/next', 'start', '--hostname', '127.0.0.1', '--port', String(port)], env);
      activeLogs = process.logs;
      await waitUntil(async () => (await fetch(`http://127.0.0.1:${port}/api/v1/chain/config`, { signal: AbortSignal.timeout(1000) })).ok, process.child, process.logs);
      return process.child;
    }
    let web = await server();
    const makerCookie = await login(base, maker);
    const takerCookie = await login(base, taker);
    const ad = await checked(await post(base, '/api/v1/ads', { side: 'buy', asset: 'ETH', price: '2500', total: '1', min: '100', max: '1500', minutes: 15, validHours: 24 }, makerCookie), 201);
    const adId = ad.ad.id as string;
    const reserved = await checked(await post(base, '/api/v1/orders', { adId, amount: '1000' }, takerCookie, crypto.randomUUID()), 201);
    const orderId = reserved.order.id as string;
    await checked(await post(base, `/api/v1/orders/${orderId}/respond`, { decision: 'accept' }, makerCookie));
    const path = `/api/v1/orders/${orderId}/chain`;
    const prepared = await checked(await post(base, path, { action: 'prepare' }, takerCookie));
    const terms = prepared.chain.terms as ChainTerms;
    const typed = typedOrder(31337, fixture.escrow, terms);
    const makerSignature = await maker.signTypedData(typed);
    const takerSignature = await taker.signTypedData(typed);
    await checked(await post(base, path, { action: 'sign', signature: makerSignature }, makerCookie));
    await checked(await post(base, path, { action: 'sign', signature: takerSignature }, takerCookie));
    async function tx(account: typeof maker, address: Address, abi: typeof escrowAbi | typeof erc20Abi, functionName: string, args: unknown[]) {
      const hash = await walletClient.writeContract({ account, chain: null, address, abi, functionName, args } as Parameters<typeof walletClient.writeContract>[0]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assert.equal(receipt.status, 'success');
    }
    await tx(taker, fixture.escrow, escrowAbi, 'openOrder', [contractTerms(terms), makerSignature, takerSignature]);
    assert.equal((await checked(await fetch(base + path, { headers: { Cookie: takerCookie } }))).chain.state, 'OPEN');
    await tx(maker, fixture.weth, erc20Abi, 'approve', [fixture.escrow, BigInt(terms.makerDeposit)]);
    await tx(maker, fixture.escrow, escrowAbi, 'depositMaker', [terms.orderId]);
    assert.equal((await checked(await fetch(base + path, { headers: { Cookie: makerCookie } }))).chain.state, 'MAKER_FUNDED');
    const beforeRestart = projection(adId, orderId);
    assert.equal(beforeRestart.events.length, 2);
    assert.ok(beforeRestart.checkpoints.length > 0);

    await stop(web);
    web = await server();
    const recovered = await checked(await fetch(base + path, { headers: { Cookie: takerCookie } }));
    assert.equal(recovered.chain.state, 'MAKER_FUNDED');
    assert.deepEqual(projection(adId, orderId), beforeRestart);

    const laggingWeb = await server(laggingWebPort, { ...webEnv, P2P_CHAIN_RPC_URL: laggingProxyUrl });
    pauseLagging = true;
    const staleRequest = fetch(laggingBase + path, { headers: { Cookie: takerCookie } });
    let pauseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([laggingPaused, new Promise((_, reject) => {
        pauseTimer = setTimeout(() => reject(new Error('Second server did not pause after reading the previous checkpoint.')), 10_000);
      })]);
    } finally { clearTimeout(pauseTimer); }
    rpcAvailable = false;
    await checked(await post(base, path, { action: 'sync' }, takerCookie), 503);
    assert.deepEqual(projection(adId, orderId), beforeRestart);
    await tx(taker, fixture.usdc, erc20Abi, 'approve', [fixture.escrow, BigInt(terms.takerDeposit)]);
    await tx(taker, fixture.escrow, escrowAbi, 'depositTaker', [terms.orderId]);
    await checked(await fetch(base + path, { headers: { Cookie: takerCookie } }), 503);
    assert.deepEqual(projection(adId, orderId), beforeRestart);
    rpcAvailable = true;
    const settled = await checked(await fetch(base + path, { headers: { Cookie: takerCookie } }));
    assert.equal(settled.chain.state, 'SETTLED');
    assert.deepEqual(settled.chain.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited', 'OrderSettled']);
    const baseline = projection(adId, orderId);
    assert.equal(baseline.events.length, 3);
    assert.equal(baseline.history.filter(event => (event as { state: string }).state === 'SETTLED').length, 1);
    assert.equal((baseline.ad as { total_units: string }).total_units, '600000000000000000');
    assert.equal((baseline.ad as { available_units: string }).available_units, '600000000000000000');
    releaseLagging?.();
    const lateResponse = await checked(await staleRequest);
    assert.equal(lateResponse.chain.state, 'SETTLED');
    assert.deepEqual(projection(adId, orderId), baseline);
    const simultaneous = await Promise.all(Array.from({ length: 8 }, (_, index) =>
      post(index % 2 === 0 ? base : laggingBase, path, { action: 'sync' }, takerCookie).then(response => checked(response))));
    assert.ok(simultaneous.every(result => result.chain.state === 'SETTLED'));
    assert.deepEqual(projection(adId, orderId), baseline);
    await stop(laggingWeb);

    for (let repeat = 0; repeat < 3; repeat++) {
      const result = await checked(await post(base, path, { action: 'sync' }, takerCookie));
      assert.equal(result.chain.state, 'SETTLED');
      assert.deepEqual(projection(adId, orderId), baseline);
    }
    const database = new DatabaseSync(databasePath);
    try { database.prepare('DELETE FROM chain_blocks WHERE chain_id=31337').run(); }
    finally { database.close(); }
    const replayed = await checked(await post(base, path, { action: 'sync' }, takerCookie));
    assert.equal(replayed.chain.state, 'SETTLED');
    const afterReplay = projection(adId, orderId);
    assert.deepEqual({ ...afterReplay, checkpoints: baseline.checkpoints }, baseline);
    assert.deepEqual(afterReplay.checkpoints.at(-1), baseline.checkpoints.at(-1));

    // Preserve the settled checkpoint when changing the test server to two confirmations.
    await publicClient.request({ method: 'evm_mine' as never, params: [] as never });
    await stop(web);
    web = await server(webPort, { ...webEnv, P2P_CHAIN_CONFIRMATIONS: '2' });
    const confirmationConfig = await checked(await fetch(base + '/api/v1/chain/config'));
    assert.equal(confirmationConfig.config.confirmations, 2);
    const second = await checked(await post(base, '/api/v1/orders', { adId, amount: '100' }, takerCookie, crypto.randomUUID()), 201);
    const secondId = second.order.id as string;
    const secondPath = `/api/v1/orders/${secondId}/chain`;
    await checked(await post(base, `/api/v1/orders/${secondId}/respond`, { decision: 'accept' }, makerCookie));
    const secondPrepared = await checked(await post(base, secondPath, { action: 'prepare' }, takerCookie));
    const secondTerms = secondPrepared.chain.terms as ChainTerms;
    const secondTyped = typedOrder(31337, fixture.escrow, secondTerms);
    const secondMakerSignature = await maker.signTypedData(secondTyped);
    const secondTakerSignature = await taker.signTypedData(secondTyped);
    await checked(await post(base, secondPath, { action: 'sign', signature: secondMakerSignature }, makerCookie));
    await checked(await post(base, secondPath, { action: 'sign', signature: secondTakerSignature }, takerCookie));
    async function secondChain() {
      return (await checked(await fetch(base + secondPath, { headers: { Cookie: takerCookie } }))).chain;
    }
    async function mine() { await publicClient.request({ method: 'evm_mine' as never, params: [] as never }); }
    const beforeOpen = projection(adId, secondId);
    await tx(taker, fixture.escrow, escrowAbi, 'openOrder', [contractTerms(secondTerms), secondMakerSignature, secondTakerSignature]);
    assert.equal((await secondChain()).state, 'CHAIN_SIGNING');
    assert.equal(projection(adId, secondId).events.length, 0);
    assert.deepEqual(withoutCheckpoints(projection(adId, secondId)), withoutCheckpoints(beforeOpen));
    await mine();
    assert.equal((await secondChain()).state, 'OPEN');
    await tx(maker, fixture.weth, erc20Abi, 'approve', [fixture.escrow, BigInt(secondTerms.makerDeposit)]);
    const beforeMaker = projection(adId, secondId);
    await tx(maker, fixture.escrow, escrowAbi, 'depositMaker', [secondTerms.orderId]);
    const pendingMaker = await secondChain();
    assert.equal(pendingMaker.state, 'OPEN');
    assert.equal(pendingMaker.events.length, 1);
    assert.deepEqual(withoutCheckpoints(projection(adId, secondId)), withoutCheckpoints(beforeMaker));
    await mine();
    assert.equal((await secondChain()).state, 'MAKER_FUNDED');
    await tx(taker, fixture.usdc, erc20Abi, 'approve', [fixture.escrow, BigInt(secondTerms.takerDeposit)]);
    const beforeSettlement = projection(adId, secondId);
    await tx(taker, fixture.escrow, escrowAbi, 'depositTaker', [secondTerms.orderId]);
    const pendingSettlement = await secondChain();
    assert.equal(pendingSettlement.state, 'MAKER_FUNDED');
    assert.equal(pendingSettlement.events.length, 2);
    const beforeConfirmation = projection(adId, secondId);
    assert.deepEqual(withoutCheckpoints(beforeConfirmation), withoutCheckpoints(beforeSettlement));
    assert.equal((beforeConfirmation.ad as { total_units: string }).total_units, '600000000000000000');
    assert.equal((beforeConfirmation.ad as { available_units: string }).available_units, '560000000000000000');
    await mine();
    const confirmedSettlement = await secondChain();
    assert.equal(confirmedSettlement.state, 'SETTLED');
    assert.deepEqual(confirmedSettlement.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited', 'OrderSettled']);
    const afterConfirmation = projection(adId, secondId);
    assert.equal((afterConfirmation.ad as { total_units: string }).total_units, '560000000000000000');
    assert.equal((afterConfirmation.ad as { available_units: string }).available_units, '560000000000000000');
    assert.equal(afterConfirmation.history.filter(event => (event as { state: string }).state === 'SETTLED').length, 1);
    await secondChain();
    assert.deepEqual(projection(adId, secondId), afterConfirmation);

    const third = await checked(await post(base, '/api/v1/orders', { adId, amount: '100' }, takerCookie, crypto.randomUUID()), 201);
    const thirdId = third.order.id as string;
    const thirdPath = `/api/v1/orders/${thirdId}/chain`;
    await checked(await post(base, `/api/v1/orders/${thirdId}/respond`, { decision: 'accept' }, makerCookie));
    const thirdPrepared = await checked(await post(base, thirdPath, { action: 'prepare' }, takerCookie));
    const thirdTerms = thirdPrepared.chain.terms as ChainTerms;
    const thirdTyped = typedOrder(31337, fixture.escrow, thirdTerms);
    const thirdMakerSignature = await maker.signTypedData(thirdTyped);
    const thirdTakerSignature = await taker.signTypedData(thirdTyped);
    await checked(await post(base, thirdPath, { action: 'sign', signature: thirdMakerSignature }, makerCookie));
    await checked(await post(base, thirdPath, { action: 'sign', signature: thirdTakerSignature }, takerCookie));
    async function thirdChain() {
      return (await checked(await fetch(base + thirdPath, { headers: { Cookie: takerCookie } }))).chain;
    }
    const beforeReorgOpen = projection(adId, thirdId);
    const openSnapshot = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'openOrder', [contractTerms(thirdTerms), thirdMakerSignature, thirdTakerSignature]);
    assert.equal((await thirdChain()).state, 'CHAIN_SIGNING');
    assert.deepEqual(withoutCheckpoints(projection(adId, thirdId)), withoutCheckpoints(beforeReorgOpen));
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [openSnapshot] as never }), true);
    await mine();
    await mine();
    const removedOpen = await thirdChain();
    assert.equal(removedOpen.state, 'CHAIN_SIGNING');
    assert.equal(removedOpen.events.length, 0);
    assert.deepEqual(withoutCheckpoints(projection(adId, thirdId)), withoutCheckpoints(beforeReorgOpen));

    await tx(taker, fixture.escrow, escrowAbi, 'openOrder', [contractTerms(thirdTerms), thirdMakerSignature, thirdTakerSignature]);
    await mine();
    assert.equal((await thirdChain()).state, 'OPEN');
    await tx(maker, fixture.weth, erc20Abi, 'approve', [fixture.escrow, BigInt(thirdTerms.makerDeposit)]);
    await tx(maker, fixture.escrow, escrowAbi, 'depositMaker', [thirdTerms.orderId]);
    await mine();
    assert.equal((await thirdChain()).state, 'MAKER_FUNDED');
    await tx(taker, fixture.usdc, erc20Abi, 'approve', [fixture.escrow, BigInt(thirdTerms.takerDeposit)]);
    const beforeReorgSettlement = projection(adId, thirdId);
    const settlementSnapshot = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'depositTaker', [thirdTerms.orderId]);
    assert.equal((await thirdChain()).state, 'MAKER_FUNDED');
    assert.deepEqual(withoutCheckpoints(projection(adId, thirdId)), withoutCheckpoints(beforeReorgSettlement));
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [settlementSnapshot] as never }), true);
    await mine();
    await mine();
    const removedSettlement = await thirdChain();
    assert.equal(removedSettlement.state, 'MAKER_FUNDED');
    assert.deepEqual(removedSettlement.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited']);
    assert.deepEqual(withoutCheckpoints(projection(adId, thirdId)), withoutCheckpoints(beforeReorgSettlement));

    const confirmedSnapshot = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'depositTaker', [thirdTerms.orderId]);
    await mine();
    const finalSettlement = await thirdChain();
    assert.equal(finalSettlement.state, 'SETTLED');
    assert.deepEqual(finalSettlement.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited', 'OrderSettled']);
    const finalProjection = projection(adId, thirdId);
    assert.equal((finalProjection.ad as { total_units: string }).total_units, '520000000000000000');
    assert.equal((finalProjection.ad as { available_units: string }).available_units, '520000000000000000');
    for (const state of ['OPEN', 'MAKER_FUNDED', 'SETTLED']) {
      assert.equal(finalProjection.history.filter(event => (event as { state: string }).state === state).length, 1);
    }
    const confirmedHead = await publicClient.getBlockNumber();
    const settlementEvent = finalProjection.events.at(-1) as { block_number: number; block_hash: string };
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [confirmedSnapshot] as never }), true);
    await mine();
    await mine();
    assert.equal(await publicClient.getBlockNumber(), confirmedHead);
    const replacement = await publicClient.getBlock({ blockNumber: BigInt(settlementEvent.block_number) });
    assert.notEqual(replacement.hash.toLowerCase(), settlementEvent.block_hash);
    const deepReorg = await thirdChain();
    assert.equal(deepReorg.state, 'MAKER_FUNDED');
    assert.deepEqual(deepReorg.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited']);
    const revertedProjection = projection(adId, thirdId);
    assert.equal((revertedProjection.order as { state: string }).state, 'MAKER_FUNDED');
    assert.equal((revertedProjection.chainOrder as { state: string }).state, 'MAKER_FUNDED');
    assert.equal((revertedProjection.ad as { total_units: string }).total_units, '560000000000000000');
    assert.equal((revertedProjection.ad as { available_units: string }).available_units, '520000000000000000');
    assert.equal(revertedProjection.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 1);
    assert.equal((revertedProjection.checkpoints.at(-1) as { block_hash: string }).block_hash, replacement.hash.toLowerCase());
    assert.equal((projection(adId, secondId).order as { state: string }).state, 'SETTLED');
    await thirdChain();
    assert.deepEqual(projection(adId, thirdId), revertedProjection);

    await tx(taker, fixture.escrow, escrowAbi, 'depositTaker', [thirdTerms.orderId]);
    await mine();
    const reconfirmed = await thirdChain();
    assert.equal(reconfirmed.state, 'SETTLED');
    assert.deepEqual(reconfirmed.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened', 'MakerDeposited', 'OrderSettled']);
    const reconfirmedProjection = projection(adId, thirdId);
    assert.equal((reconfirmedProjection.ad as { total_units: string }).total_units, '520000000000000000');
    assert.equal((reconfirmedProjection.ad as { available_units: string }).available_units, '520000000000000000');
    assert.equal(reconfirmedProjection.history.filter(event => (event as { state: string }).state === 'SETTLED').length, 2);
    assert.equal(reconfirmedProjection.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 1);

    const limitedAd = await checked(await post(base, '/api/v1/ads', { side: 'buy', asset: 'ETH', price: '2500', total: '0.04', min: '100', max: '100', minutes: 15, validHours: 24 }, makerCookie), 201);
    const limitedAdId = limitedAd.ad.id as string;
    const competitorCookie = await login(base, competitor);
    const cancellable = await checked(await post(base, '/api/v1/orders', { adId: limitedAdId, amount: '100' }, takerCookie, crypto.randomUUID()), 201);
    const cancellableId = cancellable.order.id as string;
    const cancellablePath = `/api/v1/orders/${cancellableId}/chain`;
    await checked(await post(base, `/api/v1/orders/${cancellableId}/respond`, { decision: 'accept' }, makerCookie));
    const cancellablePrepared = await checked(await post(base, cancellablePath, { action: 'prepare' }, takerCookie));
    const cancellableTerms = cancellablePrepared.chain.terms as ChainTerms;
    const cancellableTyped = typedOrder(31337, fixture.escrow, cancellableTerms);
    const cancelMakerSignature = await maker.signTypedData(cancellableTyped);
    const cancelTakerSignature = await taker.signTypedData(cancellableTyped);
    await checked(await post(base, cancellablePath, { action: 'sign', signature: cancelMakerSignature }, makerCookie));
    await checked(await post(base, cancellablePath, { action: 'sign', signature: cancelTakerSignature }, takerCookie));
    await tx(taker, fixture.escrow, escrowAbi, 'openOrder', [contractTerms(cancellableTerms), cancelMakerSignature, cancelTakerSignature]);
    await mine();
    assert.equal((await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }))).chain.state, 'OPEN');
    const beforeCancellation = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'cancelUnfunded', [cancellableTerms.orderId]);
    await mine();
    assert.equal((await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }))).chain.state, 'CANCELLED');
    const cancelledProjection = projection(limitedAdId, cancellableId);
    assert.equal((cancelledProjection.ad as { available_units: string }).available_units, '40000000000000000');
    const competing = await checked(await post(base, '/api/v1/orders', { adId: limitedAdId, amount: '100' }, competitorCookie, crypto.randomUUID()), 201);
    const competingId = competing.order.id as string;
    const beforeConflict = projection(limitedAdId, cancellableId);
    const competingBeforeConflict = projection(limitedAdId, competingId);
    assert.equal((beforeConflict.ad as { available_units: string }).available_units, '0');
    const cancelledEvent = beforeConflict.events.at(-1) as { block_number: number; block_hash: string };
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [beforeCancellation] as never }), true);
    await mine();
    await mine();
    const replacementCancellation = await publicClient.getBlock({ blockNumber: BigInt(cancelledEvent.block_number) });
    assert.notEqual(replacementCancellation.hash.toLowerCase(), cancelledEvent.block_hash);
    const conflict = await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }), 503);
    assert.match(conflict.error as string, /재고 충돌/);
    assert.deepEqual(projection(limitedAdId, cancellableId), beforeConflict);
    assert.deepEqual(projection(limitedAdId, competingId), competingBeforeConflict);
    const repeatedConflict = await checked(await post(base, cancellablePath, { action: 'sync' }, takerCookie), 503);
    assert.match(repeatedConflict.error as string, /재고 충돌/);
    assert.deepEqual(projection(limitedAdId, cancellableId), beforeConflict);

    assert.equal((await post(base, `/api/v1/orders/${competingId}/cancel`, {}, takerCookie)).status, 404);
    const releasedCompeting = await checked(await post(base, `/api/v1/orders/${competingId}/cancel`, {}, competitorCookie));
    assert.equal(releasedCompeting.order.state, 'CANCELLED');
    const recoveredCancellation = await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }));
    assert.equal(recoveredCancellation.chain.state, 'OPEN');
    assert.deepEqual(recoveredCancellation.chain.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened']);
    const recoveredStock = projection(limitedAdId, cancellableId);
    assert.equal((recoveredStock.ad as { total_units: string }).total_units, '40000000000000000');
    assert.equal((recoveredStock.ad as { available_units: string }).available_units, '0');
    assert.equal(recoveredStock.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 1);
    assert.equal((projection(limitedAdId, competingId).order as { state: string }).state, 'CANCELLED');

    const beforeExpiryCancellation = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'cancelUnfunded', [cancellableTerms.orderId]);
    await mine();
    assert.equal((await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }))).chain.state, 'CANCELLED');
    const expiring = await checked(await post(base, '/api/v1/orders', { adId: limitedAdId, amount: '100' }, competitorCookie, crypto.randomUUID()), 201);
    const expiringId = expiring.order.id as string;
    assert.equal((projection(limitedAdId, expiringId).order as { state: string }).state, 'RESERVED');
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [beforeExpiryCancellation] as never }), true);
    await mine();
    await mine();
    const expiringConflict = await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }), 503);
    assert.match(expiringConflict.error as string, /재고 충돌/);
    const beforeExpiry = projection(limitedAdId, cancellableId);
    const databaseForExpiry = new DatabaseSync(databasePath);
    try {
      databaseForExpiry.prepare('UPDATE orders SET response_due_at=? WHERE id=? AND state=\'RESERVED\'').run(Date.now() - 1, expiringId);
    } finally { databaseForExpiry.close(); }
    const expired = await checked(await fetch(base + `/api/v1/orders/${expiringId}`, { headers: { Cookie: competitorCookie } }));
    assert.equal(expired.order.state, 'EXPIRED');
    assert.equal(expired.events.filter((event: { state: string; actor: string }) => event.state === 'EXPIRED' && event.actor === 'system').length, 1);
    assert.equal((projection(limitedAdId, expiringId).ad as { available_units: string }).available_units, '40000000000000000');
    const afterExpiry = await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }));
    assert.equal(afterExpiry.chain.state, 'OPEN');
    assert.deepEqual(afterExpiry.chain.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened']);
    const recoveredAfterExpiry = projection(limitedAdId, cancellableId);
    assert.equal((recoveredAfterExpiry.ad as { total_units: string }).total_units, '40000000000000000');
    assert.equal((recoveredAfterExpiry.ad as { available_units: string }).available_units, '0');
    assert.equal(recoveredAfterExpiry.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 2);
    assert.equal((projection(limitedAdId, expiringId).order as { state: string }).state, 'EXPIRED');
    assert.ok(recoveredAfterExpiry.history.length > beforeExpiry.history.length);
    await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }));
    assert.deepEqual(projection(limitedAdId, cancellableId), recoveredAfterExpiry);
    const expiryResolved = projection(limitedAdId, expiringId);
    await checked(await fetch(base + `/api/v1/orders/${expiringId}`, { headers: { Cookie: competitorCookie } }));
    assert.deepEqual(projection(limitedAdId, expiringId), expiryResolved);

    const beforeWorkerCancellation = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    await tx(taker, fixture.escrow, escrowAbi, 'cancelUnfunded', [cancellableTerms.orderId]);
    await mine();
    assert.equal((await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }))).chain.state, 'CANCELLED');
    const workerCompeting = await checked(await post(base, '/api/v1/orders', { adId: limitedAdId, amount: '100' }, competitorCookie, crypto.randomUUID()), 201);
    const workerCompetingId = workerCompeting.order.id as string;
    assert.equal((projection(limitedAdId, workerCompetingId).order as { state: string }).state, 'RESERVED');
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [beforeWorkerCancellation] as never }), true);
    await mine();
    await mine();
    const workerConflict = await checked(await fetch(base + cancellablePath, { headers: { Cookie: takerCookie } }), 503);
    assert.match(workerConflict.error as string, /재고 충돌/);
    const beforeWorkerExpiry = projection(limitedAdId, cancellableId);
    const expiryWorker = start(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'scripts/expire-reservations-worker.ts'], {
      ...webEnv, P2P_EXPIRY_INTERVAL_MS: '200',
    });
    await waitUntil(async () => expiryWorker.logs().includes('예약 만료 작업 시작'), expiryWorker.child, expiryWorker.logs);
    const workerDatabase = new DatabaseSync(databasePath);
    try {
      workerDatabase.prepare("UPDATE orders SET response_due_at=? WHERE id=? AND state='RESERVED'").run(Date.now() - 1, workerCompetingId);
    } finally { workerDatabase.close(); }
    await waitUntil(async () => {
      const competingProjection = projection(limitedAdId, workerCompetingId);
      return (competingProjection.order as { state: string }).state === 'EXPIRED'
        && (competingProjection.ad as { available_units: string }).available_units === '40000000000000000';
    }, expiryWorker.child, expiryWorker.logs);
    const workerExpired = projection(limitedAdId, workerCompetingId);
    assert.equal(workerExpired.history.filter(event => (event as { state: string; actor: string }).state === 'EXPIRED' && (event as { actor: string }).actor === 'system').length, 1);
    const beforeWorkerSync = projection(limitedAdId, cancellableId);
    assert.equal((beforeWorkerSync.order as { state: string }).state, 'CANCELLED');
    assert.deepEqual(beforeWorkerSync.order, beforeWorkerExpiry.order);
    assert.deepEqual(beforeWorkerSync.chainOrder, beforeWorkerExpiry.chainOrder);
    assert.deepEqual(beforeWorkerSync.history, beforeWorkerExpiry.history);
    assert.deepEqual(beforeWorkerSync.events, beforeWorkerExpiry.events);
    assert.deepEqual(beforeWorkerSync.checkpoints, beforeWorkerExpiry.checkpoints);
    assert.equal((beforeWorkerSync.ad as { available_units: string }).available_units, '40000000000000000');
    assert.equal((beforeWorkerSync.ad as { version: number }).version, (beforeWorkerExpiry.ad as { version: number }).version + 1);
    const workerRecovered = await checked(await post(base, cancellablePath, { action: 'sync' }, takerCookie));
    assert.equal(workerRecovered.chain.state, 'OPEN');
    assert.deepEqual(workerRecovered.chain.events.map((event: { event_name: string }) => event.event_name), ['OrderOpened']);
    const recoveredAfterWorker = projection(limitedAdId, cancellableId);
    assert.equal((recoveredAfterWorker.ad as { total_units: string }).total_units, '40000000000000000');
    assert.equal((recoveredAfterWorker.ad as { available_units: string }).available_units, '0');
    assert.equal(recoveredAfterWorker.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 3);
    const competingAfterWorker = projection(limitedAdId, workerCompetingId);
    assert.equal((competingAfterWorker.order as { state: string }).state, 'EXPIRED');
    await new Promise(resolve => setTimeout(resolve, 450));
    await checked(await post(base, cancellablePath, { action: 'sync' }, takerCookie));
    assert.deepEqual(projection(limitedAdId, cancellableId), recoveredAfterWorker);
    assert.deepEqual(projection(limitedAdId, workerCompetingId), competingAfterWorker);
    const chainWorkerEnv = {
      ...webEnv, P2P_CHAIN_CONFIRMATIONS: '2', P2P_CHAIN_SYNC_INTERVAL_MS: '200',
    };
    const chainWorkerArgs = ['--import', 'tsx', '--conditions=react-server', 'scripts/sync-chain-worker.ts'];
    const chainWorker = start(process.execPath, chainWorkerArgs, chainWorkerEnv);
    await waitUntil(async () => chainWorker.logs().includes('체인 로그 동기화 작업 시작'), chainWorker.child, chainWorker.logs);
    const beforeAutomaticCancellation = await publicClient.request({ method: 'evm_snapshot' as never, params: [] as never }) as string;
    const beforeAutomaticRpcFailure = projection(limitedAdId, cancellableId);
    rpcAvailable = false;
    await tx(taker, fixture.escrow, escrowAbi, 'cancelUnfunded', [cancellableTerms.orderId]);
    await mine();
    await waitUntil(async () => chainWorker.logs().includes('로컬 체인 RPC를 확인할 수 없습니다'), chainWorker.child, chainWorker.logs);
    assert.deepEqual(projection(limitedAdId, cancellableId), beforeAutomaticRpcFailure);
    rpcAvailable = true;
    await waitUntil(async () => (projection(limitedAdId, cancellableId).order as { state: string }).state === 'CANCELLED', chainWorker.child, chainWorker.logs);
    const automaticallyCancelled = projection(limitedAdId, cancellableId);
    assert.equal((automaticallyCancelled.ad as { available_units: string }).available_units, '40000000000000000');
    assert.deepEqual(automaticallyCancelled.events.map(event => (event as { event_name: string }).event_name), ['OrderOpened', 'OrderCancelled']);
    const automaticCompeting = await checked(await post(base, '/api/v1/orders', { adId: limitedAdId, amount: '100' }, competitorCookie, crypto.randomUUID()), 201);
    const automaticCompetingId = automaticCompeting.order.id as string;
    const beforeAutomaticConflict = projection(limitedAdId, cancellableId);
    assert.equal((beforeAutomaticConflict.ad as { available_units: string }).available_units, '0');
    assert.equal(await publicClient.request({ method: 'evm_revert' as never, params: [beforeAutomaticCancellation] as never }), true);
    await mine();
    await mine();
    await waitUntil(async () => chainWorker.logs().includes('재고 충돌'), chainWorker.child, chainWorker.logs);
    assert.deepEqual(projection(limitedAdId, cancellableId), beforeAutomaticConflict);
    const databaseForAutomaticRecovery = new DatabaseSync(databasePath);
    try {
      databaseForAutomaticRecovery.prepare("UPDATE orders SET response_due_at=? WHERE id=? AND state='RESERVED'").run(Date.now() - 1, automaticCompetingId);
    } finally { databaseForAutomaticRecovery.close(); }
    await waitUntil(async () => {
      const recovered = projection(limitedAdId, cancellableId);
      const competitorState = projection(limitedAdId, automaticCompetingId).order as { state: string };
      return competitorState.state === 'EXPIRED' && (recovered.order as { state: string }).state === 'OPEN';
    }, chainWorker.child, () => `${chainWorker.logs()}\n${expiryWorker.logs()}`);
    const automaticallyRecovered = projection(limitedAdId, cancellableId);
    const automaticallyExpired = projection(limitedAdId, automaticCompetingId);
    assert.deepEqual(automaticallyRecovered.events.map(event => (event as { event_name: string }).event_name), ['OrderOpened']);
    assert.equal((automaticallyRecovered.ad as { total_units: string }).total_units, '40000000000000000');
    assert.equal((automaticallyRecovered.ad as { available_units: string }).available_units, '0');
    assert.equal(automaticallyRecovered.history.filter(event => (event as { actor: string }).actor === 'chain-reorg').length, 4);
    assert.equal(automaticallyExpired.history.filter(event => (event as { state: string; actor: string }).state === 'EXPIRED' && (event as { actor: string }).actor === 'system').length, 1);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(projection(limitedAdId, cancellableId), automaticallyRecovered);
    assert.deepEqual(projection(limitedAdId, automaticCompetingId), automaticallyExpired);

    await stop(chainWorker.child);
    const beforeWorkerRace = projection(limitedAdId, cancellableId);
    await tx(taker, fixture.escrow, escrowAbi, 'cancelUnfunded', [cancellableTerms.orderId]);
    await mine();
    pauseWorkerScan = true;
    const laggingWorker = start(process.execPath, chainWorkerArgs, { ...chainWorkerEnv, P2P_CHAIN_RPC_URL: laggingProxyUrl });
    await waitUntil(async () => workerScanHeld, laggingWorker.child, laggingWorker.logs);
    assert.deepEqual(projection(limitedAdId, cancellableId), beforeWorkerRace);
    const restartedWorker = start(process.execPath, chainWorkerArgs, chainWorkerEnv);
    await waitUntil(async () => (projection(limitedAdId, cancellableId).order as { state: string }).state === 'CANCELLED', restartedWorker.child, restartedWorker.logs);
    const raceWinner = projection(limitedAdId, cancellableId);
    assert.equal((raceWinner.ad as { available_units: string }).available_units, '40000000000000000');
    assert.equal((raceWinner.ad as { version: number }).version, (beforeWorkerRace.ad as { version: number }).version + 1);
    assert.equal(raceWinner.history.length, beforeWorkerRace.history.length + 1);
    assert.deepEqual(raceWinner.events.map(event => (event as { event_name: string }).event_name), ['OrderOpened', 'OrderCancelled']);
    assert.notDeepEqual(raceWinner.checkpoints, beforeWorkerRace.checkpoints);
    assert.equal(laggingWorker.logs().includes('체인 로그 동기화 작업 시작'), false);
    releaseWorkerScan?.();
    await waitUntil(async () => laggingWorker.logs().includes('체인 로그 동기화 작업 시작'), laggingWorker.child, laggingWorker.logs);
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.deepEqual(projection(limitedAdId, cancellableId), raceWinner);
    await Promise.all([stop(expiryWorker.child), stop(restartedWorker.child), stop(laggingWorker.child)]);

    type WorkerStatus={pid:number|null;state:string;restarts:number;lastSuccessAt:number|null};
    type SupervisorStatus={supervisorPid:number;workers:{reservations:WorkerStatus;chain:WorkerStatus}};
    const workerStatus=()=>JSON.parse(readFileSync(`${databasePath}.workers.json`,'utf8')) as SupervisorStatus;
    const supervisorEnv={...chainWorkerEnv,P2P_EXPIRY_INTERVAL_MS:'200'};
    const supervisor=start(process.execPath,['scripts/supervise-workers.mjs'],supervisorEnv);
    await waitUntil(async () => {
      const status=workerStatus();
      return status.workers.chain.state==='ok'&&status.workers.reservations.state==='ok';
    },supervisor.child,supervisor.logs);
    const initialStatus=workerStatus();
    assert.equal(initialStatus.supervisorPid,supervisor.child.pid);
    const duplicateSupervisor=spawnSync(process.execPath,['scripts/supervise-workers.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.notEqual(duplicateSupervisor.status,0);
    assert.match(duplicateSupervisor.stderr,/이미 실행 중/);
    const initialChainPid=initialStatus.workers.chain.pid!;
    process.kill(initialChainPid,'SIGKILL');
    await waitUntil(async () => workerStatus().workers.chain.state==='restarting',supervisor.child,supervisor.logs);
    const duringRestart=spawnSync(process.execPath,['scripts/workers-status.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.equal(duringRestart.status,1,duringRestart.stderr);
    await waitUntil(async () => {
      const chain=workerStatus().workers.chain;
      return chain.pid!==initialChainPid&&chain.restarts===1&&chain.state==='ok';
    },supervisor.child,supervisor.logs);
    const initialExpiryPid=workerStatus().workers.reservations.pid!;
    process.kill(initialExpiryPid,'SIGKILL');
    await waitUntil(async () => {
      const expiry=workerStatus().workers.reservations;
      return expiry.pid!==initialExpiryPid&&expiry.restarts===1&&expiry.state==='ok';
    },supervisor.child,supervisor.logs);
    const beforeSupervisorMine=projection(limitedAdId,cancellableId);
    await mine();
    await waitUntil(async () => {
      const after=projection(limitedAdId,cancellableId);
      return (after.checkpoints.at(-1) as {block_number:number}).block_number>(beforeSupervisorMine.checkpoints.at(-1) as {block_number:number}).block_number;
    },supervisor.child,supervisor.logs);
    const healthyStatus=spawnSync(process.execPath,['scripts/workers-status.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.equal(healthyStatus.status,0,healthyStatus.stderr);
    assert.equal((JSON.parse(healthyStatus.stdout) as {healthy:boolean}).healthy,true);
    const beforeSupervisorCrash=workerStatus();
    const supervisorExit=new Promise<void>(resolve=>supervisor.child.once('exit',()=>resolve()));
    supervisor.child.kill('SIGKILL');
    await supervisorExit;
    const crashedHealth=spawnSync(process.execPath,['scripts/workers-status.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.equal(crashedHealth.status,1,crashedHealth.stderr);
    // systemd의 KillMode=control-group이 담당하는 자식 프로세스 정리를 시험에서 재현한다.
    for(const pid of [beforeSupervisorCrash.workers.chain.pid,beforeSupervisorCrash.workers.reservations.pid]) {
      if(pid) {try {process.kill(pid,'SIGKILL');} catch(error) {if((error as NodeJS.ErrnoException).code!=='ESRCH') throw error;}}
    }
    const replacementSupervisor=start(process.execPath,['scripts/supervise-workers.mjs'],supervisorEnv);
    await waitUntil(async()=>{
      const status=workerStatus();
      return status.supervisorPid===replacementSupervisor.child.pid
        &&status.workers.chain.state==='ok'
        &&status.workers.reservations.state==='ok'
        &&status.workers.chain.pid!==beforeSupervisorCrash.workers.chain.pid
        &&status.workers.reservations.pid!==beforeSupervisorCrash.workers.reservations.pid;
    },replacementSupervisor.child,replacementSupervisor.logs);
    const restartedHealth=spawnSync(process.execPath,['scripts/workers-status.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.equal(restartedHealth.status,0,restartedHealth.stderr);
    const beforeReplacementMine=projection(limitedAdId,cancellableId);
    await mine();
    await waitUntil(async()=>{
      const after=projection(limitedAdId,cancellableId);
      return (after.checkpoints.at(-1) as {block_number:number}).block_number>(beforeReplacementMine.checkpoints.at(-1) as {block_number:number}).block_number;
    },replacementSupervisor.child,replacementSupervisor.logs);
    await stop(replacementSupervisor.child);
    const stoppedStatus=workerStatus();
    assert.equal(stoppedStatus.workers.chain.state,'stopped');
    assert.equal(stoppedStatus.workers.reservations.state,'stopped');
    const afterStop=spawnSync(process.execPath,['scripts/workers-status.mjs'],{cwd:process.cwd(),env:supervisorEnv,encoding:'utf8'});
    assert.equal(afterStop.status,1,afterStop.stderr);
    console.log('PASS: restart, RPC outage, two-server and two-worker stale scan races, background recovery, and supervisor crash/relaunch restore healthy workers and chain progress.');
    await stop(web);
  } catch (error) {
    console.error(`Web server logs:\n${activeLogs()}`);
    throw error;
  } finally {
    releaseLagging?.();
    releaseWorkerScan?.();
    await Promise.all(children.map(stop));
    if (rpcProxy) {
      rpcProxy.closeAllConnections();
      await new Promise<void>(resolve => rpcProxy!.close(() => resolve()));
    }
    if (laggingProxy) {
      laggingProxy.closeAllConnections();
      await new Promise<void>(resolve => laggingProxy!.close(() => resolve()));
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
