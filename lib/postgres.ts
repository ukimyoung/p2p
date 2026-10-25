import pg, { type PoolClient, type QueryResultRow } from 'pg';

const { Pool, types }=pg;
types.setTypeParser(20,value=>{
  const number=Number(value);
  if(!Number.isSafeInteger(number)) throw new Error('PostgreSQL bigint 값이 JavaScript 안전 정수 범위를 벗어났습니다.');
  return number;
});

let pool:pg.Pool|undefined;
export function postgresEnabled() {
  if(!process.env.DATABASE_URL&&(process.env.P2P_REQUIRE_POSTGRES==='true'||process.env.VERCEL)) throw new Error('PostgreSQL 배포에는 DATABASE_URL이 필요합니다.');
  return !!process.env.DATABASE_URL;
}
export function postgresPool() {
  if(pool) return pool;
  const connectionString=process.env.DATABASE_URL;
  if(!connectionString) throw new Error('Supabase PostgreSQL 연결 문자열 DATABASE_URL이 필요합니다.');
  const max=Number(process.env.P2P_PG_POOL_MAX??(process.env.VERCEL?1:5));
  if(!Number.isSafeInteger(max)||max<1||max>20) throw new Error('P2P_PG_POOL_MAX는 1~20이어야 합니다.');
  const url=new URL(connectionString);
  if(url.hostname.endsWith('.supabase.co')||url.hostname.endsWith('.pooler.supabase.com')) url.searchParams.set('sslmode','verify-full');
  pool=new Pool({connectionString:url.toString(),max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000});
  return pool;
}
export type Queryable=Pick<PoolClient,'query'>;
export async function query<T extends QueryResultRow=Record<string,unknown>>(sql:string,values:unknown[]=[],client?:Queryable) {
  return (client??postgresPool()).query<T>(sql,values);
}
export async function transaction<T>(work:(client:PoolClient)=>Promise<T>) {
  const client=await postgresPool().connect();
  try {
    await client.query('BEGIN');
    const result=await work(client);
    await client.query('COMMIT');
    return result;
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {client.release();}
}
export async function closePostgres() {if(pool) {await pool.end();pool=undefined;}}
