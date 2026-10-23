import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const name=`p2p-postgres-check-${process.pid}-${randomBytes(3).toString('hex')}`;
const migration=readFileSync(resolve('supabase/migrations/20261023000100_initial_p2p.sql'),'utf8');
const psql=['exec','-i',name,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-d','p2p','-At'];

function docker(args,input) {
  const result=spawnSync('docker',args,{encoding:'utf8',input,maxBuffer:1024*1024});
  if(result.error) throw result.error;
  if(result.status!==0) throw new Error(`docker ${args.join(' ')} 실패: ${result.stderr||result.stdout}`);
  return result.stdout.trim();
}
function sql(query) {return docker([...psql,'-c',query]);}
function sqlFailure(query) {
  const result=spawnSync('docker',[...psql,'-c',query],{encoding:'utf8'});
  assert.notEqual(result.status,0,`예상한 SQL 오류가 발생하지 않았습니다: ${query}`);
}
function claim() {
  return new Promise((resolveClaim,reject)=>{
    const child=spawn('docker',[...psql,'-c',"WITH claim AS (UPDATE p2p.ads SET available_units=available_units-1, version=version+1 WHERE id='concurrent-ad' AND status='ACTIVE' AND available_units>=1 RETURNING id) SELECT count(*) FROM claim"],{stdio:['ignore','pipe','pipe']});
    let output='';let error='';
    child.stdout.on('data',chunk=>{output+=chunk;});
    child.stderr.on('data',chunk=>{error+=chunk;});
    child.on('error',reject);
    child.on('close',code=>code===0?resolveClaim(Number(output.trim())):reject(new Error(error)));
  });
}

let started=false;
try {
  docker(['run','--rm','-d','--name',name,'-e','POSTGRES_PASSWORD=local-test-only','-e','POSTGRES_DB=p2p','postgres:17-alpine']);
  started=true;
  let ready=false;
  for(let attempt=0;attempt<120;attempt++) {
    const logs=spawnSync('docker',['logs',name],{encoding:'utf8'});
    const probe=spawnSync('docker',[...psql,'-c','SELECT 1'],{encoding:'utf8'});
    if((logs.stdout+logs.stderr).includes('PostgreSQL init process complete')&&probe.status===0) {ready=true;break;}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.ok(ready,'PostgreSQL 시작 대기 시간이 초과됐습니다.');
  docker(psql,migration);
  assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='p2p'"),'12');
  assert.equal(sql("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='p2p' AND c.relkind='r' AND c.relrowsecurity"),'12');

  sql("INSERT INTO p2p.ads (id,maker,initials,side,asset,price,available_units,total_units,min,max,minutes) VALUES ('concurrent-ad','Maker','MK','buy','ETH','100',1,1,'1','100',15)");
  const claims=await Promise.all(Array.from({length:16},claim));
  assert.equal(claims.filter(value=>value===1).length,1);
  assert.equal(claims.filter(value=>value===0).length,15);
  assert.equal(sql("SELECT available_units::text || ':' || version FROM p2p.ads WHERE id='concurrent-ad'"),'0:2');
  sqlFailure("UPDATE p2p.ads SET available_units=-1 WHERE id='concurrent-ad'");
  assert.equal(sql("SELECT available_units FROM p2p.ads WHERE id='concurrent-ad'"),'0');

  const order="INSERT INTO p2p.orders (id,ad_id,taker,idempotency_key,amount,asset_amount,fee,price,terms_hash,ad_version,created_at,expires_at,state) VALUES";
  sql(`${order} ('first','concurrent-ad','taker','same-key','1',1,'0','100','hash',1,1,2,'RESERVED')`);
  sqlFailure(`${order} ('second','concurrent-ad','taker','same-key','1',1,'0','100','hash',1,1,2,'RESERVED')`);
  assert.equal(sql('SELECT count(*) FROM p2p.orders'),'1');

  sql('CREATE ROLE p2p_test_reader; GRANT USAGE ON SCHEMA p2p TO p2p_test_reader; GRANT SELECT ON p2p.ads TO p2p_test_reader');
  assert.equal(sql('SET ROLE p2p_test_reader; SELECT count(*) FROM p2p.ads'),'0');
  console.log('PASS: 12 PostgreSQL tables, RLS, nonnegative inventory, 1/16 concurrent claims, and idempotency uniqueness.');
} finally {
  if(started) spawnSync('docker',['rm','-f',name],{encoding:'utf8'});
}
