import 'server-only';
import { InputError } from './store';
import { query } from './postgres';
import { normalizePhone } from './phone';

export type Member={id:string;email:string;countryCode:string;phoneE164:string};
type AuthUser={id?:unknown;email?:unknown;email_confirmed_at?:unknown;user_metadata?:Record<string,unknown>};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emailPattern=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function config() {
  const url=process.env.SUPABASE_URL||'https://dadnogqummcpfwactszh.supabase.co';
  const key=process.env.SUPABASE_PUBLISHABLE_KEY;
  if(!key) throw new Error('SUPABASE_PUBLISHABLE_KEY가 필요합니다.');
  if(!url.startsWith('https://')&&!url.startsWith('http://127.0.0.1:')) throw new Error('Supabase Auth URL은 HTTPS여야 합니다.');
  return {url,key};
}

async function authRequest(path:string,init:RequestInit={}) {
  const {url,key}=config();
  return fetch(new URL(path,url),{...init,headers:{apikey:key,'Content-Type':'application/json',...init.headers},cache:'no-store'});
}

export function normalizeEmail(raw:unknown) {
  if(typeof raw!=='string') throw new InputError('이메일 주소를 확인하세요.');
  const email=raw.trim().toLowerCase();
  if(email.length>254||!emailPattern.test(email)) throw new InputError('이메일 주소를 확인하세요.');
  return email;
}

function password(raw:unknown) {
  if(typeof raw!=='string'||raw.length<8||raw.length>128) throw new InputError('비밀번호는 8~128자로 입력하세요.');
  return raw;
}

export async function signUp(input:Record<string,unknown>,origin:string) {
  const email=normalizeEmail(input.email);
  const secret=password(input.password);
  const phone=normalizePhone(input.countryCode,input.phone);
  if(!phone) throw new InputError('국가번호와 전화번호를 확인하세요.');
  const redirect=new URL('/auth/confirm',origin);
  const response=await authRequest(`/auth/v1/signup?redirect_to=${encodeURIComponent(redirect.toString())}`,{
    method:'POST',body:JSON.stringify({email,password:secret,data:{country_code:phone.countryCode,phone_e164:phone.phoneE164}}),
  });
  if(response.status===429) throw new InputError('인증 이메일 요청이 많습니다. 잠시 후 다시 시도하세요.',429);
  if(!response.ok) {
    const error=await response.json().catch(()=>({}));
    if(response.status===400&&error.code==='weak_password') throw new InputError('더 안전한 비밀번호를 입력하세요.');
    console.error('Supabase 회원가입 요청 실패:',response.status,error.code);
    throw new InputError('인증 이메일을 발송하지 못했습니다. 잠시 후 다시 시도하세요.',503);
  }
}

function verifiedMember(user:AuthUser):Member {
  if(typeof user.id!=='string'||!uuid.test(user.id)||typeof user.email!=='string'||typeof user.email_confirmed_at!=='string') throw new InputError('이메일 인증을 완료하세요.',403);
  const phone=normalizePhone(user.user_metadata?.country_code,user.user_metadata?.phone_e164);
  if(!phone) throw new InputError('가입 시 등록한 전화번호를 확인할 수 없습니다.',403);
  return {id:user.id,email:normalizeEmail(user.email),...phone};
}

export async function confirmAccessToken(accessToken:unknown) {
  if(typeof accessToken!=='string'||accessToken.length>4096||!accessToken) throw new InputError('인증 링크가 올바르지 않습니다.',401);
  const response=await authRequest('/auth/v1/user',{headers:{Authorization:`Bearer ${accessToken}`}});
  if(!response.ok) throw new InputError('인증 링크가 만료되었거나 올바르지 않습니다.',401);
  const member=verifiedMember(await response.json());
  await saveMember(member);
  return member;
}

export async function signIn(input:Record<string,unknown>) {
  const email=normalizeEmail(input.email);
  const secret=password(input.password);
  const response=await authRequest('/auth/v1/token?grant_type=password',{method:'POST',body:JSON.stringify({email,password:secret})});
  if(response.status===429) throw new InputError('로그인 시도가 많습니다. 잠시 후 다시 시도하세요.',429);
  if(!response.ok) {
    const error=await response.json().catch(()=>({}));
    if(error.code==='email_not_confirmed') throw new InputError('이메일 인증을 완료하세요.',403);
    throw new InputError('이메일 또는 비밀번호를 확인하세요.',401);
  }
  const data=await response.json() as {user:AuthUser};
  const member=verifiedMember(data.user);
  await saveMember(member);
  return member;
}

async function saveMember(member:Member) {
  await query(`INSERT INTO p2p.member_profiles (user_id,email,country_code,phone_e164,email_verified_at)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT (user_id) DO UPDATE
    SET email=excluded.email,country_code=excluded.country_code,phone_e164=excluded.phone_e164,email_verified_at=excluded.email_verified_at`,
    [member.id,member.email,member.countryCode,member.phoneE164,Date.now()]);
}

export async function memberById(id:string):Promise<Member|undefined> {
  if(!uuid.test(id)) return undefined;
  const result=await query<{user_id:string;email:string;country_code:string;phone_e164:string}>(
    'SELECT user_id,email,country_code,phone_e164 FROM p2p.member_profiles WHERE user_id=$1',[id]);
  const row=result.rows[0];
  return row?{id:row.user_id,email:row.email,countryCode:row.country_code,phoneE164:row.phone_e164}:undefined;
}
