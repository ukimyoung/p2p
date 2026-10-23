#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const arch = process.arch === 'x64' ? 'amd64' : process.arch;
const platform = process.platform === 'win32' ? 'win32' : process.platform;
const binaryName = platform === 'win32' ? 'forge.exe' : 'forge';
const binary = require.resolve(`@foundry-rs/forge-${platform}-${arch}/bin/${binaryName}`);
const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const result = spawnSync(binary, process.argv.slice(2), {cwd: root, stdio: 'inherit'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
