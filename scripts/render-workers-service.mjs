import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDirectory=realpathSync(fileURLToPath(new URL('..',import.meta.url)));

function quote(value) {
  if(/[\x00-\x1f\x7f]/.test(value)) throw new Error('서비스 경로에 제어 문자를 사용할 수 없습니다.');
  return `"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%')}"`;
}

function pathValue(value) {
  if(/[\x00-\x1f\x7f]/.test(value)) throw new Error('서비스 경로에 제어 문자를 사용할 수 없습니다.');
  return value.replaceAll('\\','\\\\').replaceAll('%','%%');
}

function option(name) {
  const index=process.argv.indexOf(name);
  if(index<0||!process.argv[index+1]||process.argv[index+1].startsWith('--')) {
    throw new Error(`${name}에 경로를 지정하세요.`);
  }
  return process.argv[index+1];
}

const databaseInput=option('--db');
const chainEnvInput=option('--chain-env');
const outputInput=option('--output');
if(!isAbsolute(databaseInput)||!isAbsolute(chainEnvInput)||!isAbsolute(outputInput)) {
  throw new Error('--db, --chain-env, --output에는 절대 경로를 지정하세요.');
}
if(!existsSync(databaseInput)) throw new Error(`SQLite DB가 없습니다: ${databaseInput}`);
if(!existsSync(chainEnvInput)) throw new Error(`체인 설정 파일이 없습니다: ${chainEnvInput}`);

const databasePath=realpathSync(databaseInput);
const chainEnvPath=realpathSync(chainEnvInput);
if(!statSync(databasePath).isFile()) throw new Error('SQLite DB 경로는 파일이어야 합니다.');
if(!statSync(chainEnvPath).isFile()) throw new Error('체인 설정 경로는 파일이어야 합니다.');
const chainEnv=readFileSync(chainEnvPath,'utf8');
const required=['P2P_CHAIN_RPC_URL','P2P_CHAIN_ID','P2P_ESCROW_ADDRESS','P2P_USDC_ADDRESS','P2P_WETH_ADDRESS','P2P_CHAIN_START_BLOCK'];
for(const key of required) {
  if(!chainEnv.split(/\r?\n/).some(line=>line.startsWith(`${key}=`)&&line.slice(key.length+1).trim())) {
    throw new Error(`체인 설정 파일에 ${key} 값이 없습니다.`);
  }
}
const nodePath=realpathSync(process.execPath);
const supervisorPath=resolve(projectDirectory,'scripts/supervise-workers.mjs');
const outputPath=resolve(outputInput);
const unit=`[Unit]
Description=Peer P2P worker supervisor

[Service]
Type=exec
WorkingDirectory=${pathValue(projectDirectory)}
EnvironmentFile=${pathValue(chainEnvPath)}
Environment=${quote(`P2P_DB_PATH=${databasePath}`)}
ExecStart=${quote(nodePath)} ${quote(supervisorPath)}
Restart=always
RestartSec=5s
KillMode=control-group
TimeoutStopSec=15s

[Install]
WantedBy=default.target
`;

mkdirSync(dirname(outputPath),{recursive:true,mode:0o700});
writeFileSync(outputPath,unit,{mode:0o600});
console.log(outputPath);
