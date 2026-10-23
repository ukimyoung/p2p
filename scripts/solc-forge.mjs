#!/usr/bin/env node
// Foundry's native-solc CLI wrapper for the npm solc package. The cloud image
// cannot reach soliditylang.org's binary host, so feed its standard JSON to
// the pinned solc-js version without solcjs's non-JSON stdout banner.
import solc from 'solc';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.argv.includes('--version')) {
  process.stdout.write(`solc, the solidity compiler commandline interface\nVersion: ${solc.version()}\n`);
} else if (process.argv.includes('--standard-json')) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(solc.compile(input, {import: (name) => {
    try { return {contents: readFileSync(resolve(process.cwd(), name), 'utf8')}; }
    catch { return {error: `Import not found: ${name}`}; }
  }}));
} else {
  process.stderr.write('Only --version and --standard-json are supported.\n');
  process.exitCode = 1;
}
