import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test('worker supervisor systemd unit uses the shared DB and requests restart after exit',()=>{
  const directory=mkdtempSync(join(tmpdir(),'p2p service %'));
  try {
    const database=join(directory,'p2p.sqlite');
    const chainEnv=join(directory,'chain.env');
    const output=join(directory,'p2p-workers.service');
    writeFileSync(database,'');
    writeFileSync(chainEnv,[
      'P2P_CHAIN_RPC_URL=http://127.0.0.1:8545',
      'P2P_CHAIN_ID=31337',
      'P2P_ESCROW_ADDRESS=0x0000000000000000000000000000000000000001',
      'P2P_USDC_ADDRESS=0x0000000000000000000000000000000000000002',
      'P2P_WETH_ADDRESS=0x0000000000000000000000000000000000000003',
      'P2P_CHAIN_START_BLOCK=0',
    ].join('\n')+'\n');
    const render=spawnSync(process.execPath,[resolve('scripts/render-workers-service.mjs'),'--db',database,'--chain-env',chainEnv,'--output',output],{encoding:'utf8'});
    assert.equal(render.status,0,render.stderr);
    const unit=readFileSync(output,'utf8');
    assert.match(unit,/^Restart=always$/m);
    assert.match(unit,/^RestartSec=5s$/m);
    assert.ok(unit.includes(`EnvironmentFile=${directory.replace('%','%%')}/chain.env`));
    assert.ok(unit.includes(`Environment="P2P_DB_PATH=${database.replace('%','%%')}"`));
    assert.match(unit,/^ExecStart="[^"]+" "[^"]+\/scripts\/supervise-workers\.mjs"$/m);
    assert.equal(statSync(output).mode&0o777,0o600);
    if(existsSync('/usr/bin/systemd-analyze')) {
      const verify=spawnSync('/usr/bin/systemd-analyze',['verify',output],{encoding:'utf8'});
      assert.equal(verify.status,0,verify.stderr);
      assert.equal(verify.stderr,'');
    }
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test('worker service rendering fails before writing a unit for a missing DB',()=>{
  const directory=mkdtempSync(join(tmpdir(),'p2p-service-'));
  try {
    const chainEnv=join(directory,'chain.env');
    const output=join(directory,'p2p-workers.service');
    writeFileSync(chainEnv,'P2P_CHAIN_RPC_URL=http://127.0.0.1:8545\n');
    const render=spawnSync(process.execPath,[resolve('scripts/render-workers-service.mjs'),'--db',join(directory,'missing.sqlite'),'--chain-env',chainEnv,'--output',output],{encoding:'utf8'});
    assert.notEqual(render.status,0);
    assert.match(render.stderr,/SQLite DB가 없습니다/);
    assert.equal(existsSync(output),false);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test('worker service rendering rejects incomplete chain settings',()=>{
  const directory=mkdtempSync(join(tmpdir(),'p2p-service-'));
  try {
    const database=join(directory,'p2p.sqlite');
    const chainEnv=join(directory,'chain.env');
    const output=join(directory,'p2p-workers.service');
    writeFileSync(database,'');
    writeFileSync(chainEnv,'P2P_CHAIN_RPC_URL=http://127.0.0.1:8545\n');
    const render=spawnSync(process.execPath,[resolve('scripts/render-workers-service.mjs'),'--db',database,'--chain-env',chainEnv,'--output',output],{encoding:'utf8'});
    assert.notEqual(render.status,0);
    assert.match(render.stderr,/P2P_CHAIN_ID/);
    assert.equal(existsSync(output),false);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});
