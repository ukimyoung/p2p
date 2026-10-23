#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const arch=process.arch==='x64'?'amd64':process.arch;
const platform=process.platform;
const binary=require.resolve(`@foundry-rs/anvil-${platform}-${arch}/bin/${platform==='win32'?'anvil.exe':'anvil'}`);
const result=spawnSync(binary,['--host','127.0.0.1','--port','8545','--chain-id','31337',...process.argv.slice(2)],{stdio:'inherit'});
if(result.error) throw result.error;
process.exitCode=result.status??1;
