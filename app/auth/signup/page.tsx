'use client';
import { FormEvent, useMemo, useState } from 'react';
import { getCountries, getCountryCallingCode, type CountryCode } from 'libphonenumber-js/min';
import { LanguageSelect, useLanguage } from '../../language-provider';

export default function SignupPage() {
  const {language,t}=useLanguage();
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [countryCode,setCountryCode]=useState<CountryCode>('KR');
  const [phone,setPhone]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [sent,setSent]=useState(false);
  const countries=useMemo(()=>{
    const names=new Intl.DisplayNames([language],{type:'region'});
    return getCountries().map(country=>({code:country,label:`${names.of(country)||country} (+${getCountryCallingCode(country)})`})).sort((a,b)=>a.label.localeCompare(b.label,language));
  },[language]);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try {
      const response=await fetch('/api/v1/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,countryCode,phone})});
      if(!response.ok) {const data=await response.json().catch(()=>({}));throw new Error(language==='ko'?(data.error||'회원가입 요청에 실패했습니다.'):'Could not create your account. Check the form and try again.');}
      setSent(true);setPassword('');
    }catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  return <main className="auth-page"><header className="auth-header"><a className="logo" href="/">peer<span className="logo-dot">.</span></a><LanguageSelect/></header><section className="auth-card">
    <span className="eyebrow">JOIN PEER</span><h1>{t('이메일로 회원가입','Create your account')}</h1>
    {sent?<><p role="status">{t('인증 이메일을 보냈습니다. 받은 편지함에서 인증 URL을 클릭하면 가입이 완료됩니다.','We sent a verification email. Open its link to complete your registration.')}</p><p>{t('메일이 보이지 않으면 스팸함도 확인하세요.','Check your spam folder if you do not see it.')}</p><a className="auth-link" href="/auth/login">{t('로그인으로 이동','Go to sign in')}</a></>:<form onSubmit={event=>void submit(event)}>
      <label>{t('이메일','Email')}<input type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label>
      <label>{t('비밀번호 (8자 이상)','Password (at least 8 characters)')}<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={password} onChange={event=>setPassword(event.target.value)}/></label>
      <label>{t('국가번호','Country code')}<select required value={countryCode} onChange={event=>setCountryCode(event.target.value as CountryCode)}>{countries.map(country=><option key={country.code} value={country.code}>{country.label}</option>)}</select></label>
      <label>{t('전화번호','Phone number')}<input type="tel" autoComplete="tel-national" required value={phone} onChange={event=>setPhone(event.target.value)} placeholder={t('010-1234-5678','Phone number')}/></label>
      <p className="auth-help">{t('전화번호 입력은 필수이며 SMS 인증은 진행하지 않습니다.','A phone number is required. SMS verification is not used.')}</p>
      {error&&<p className="error" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>{busy?t('요청 중…','Sending…'):t('인증 이메일 받기','Send verification email')}</button>
    </form>}
    <p className="auth-bottom">{t('이미 계정이 있나요?','Already have an account?')} <a href="/auth/login">{t('로그인','Sign in')}</a></p>
  </section></main>;
}
