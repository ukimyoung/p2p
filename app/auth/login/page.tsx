'use client';
import { FormEvent, useState } from 'react';
import { LanguageSelect, useLanguage } from '../../language-provider';

export default function LoginPage() {
  const {language,t}=useLanguage();
  const [email,setEmail]=useState('');
  const [password,setPassword]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();if(busy)return;setBusy(true);setError('');
    try {
      const response=await fetch('/api/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
      if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(language==='ko'?(data.error||'로그인에 실패했습니다.'):'Could not sign in. Check your email, password, and verification status.');}
      window.location.replace(new URLSearchParams(window.location.search).get('next')==='register'?'/?register=1':'/');
    }catch(cause){setError((cause as Error).message);}finally{setBusy(false);}
  }
  return <main className="auth-page"><header className="auth-header"><a className="logo" href="/">peer<span className="logo-dot">.</span></a><LanguageSelect/></header><section className="auth-card">
    <span className="eyebrow">WELCOME BACK</span><h1>{t('로그인','Sign in')}</h1>
    <form onSubmit={event=>void submit(event)}><label>{t('이메일','Email')}<input type="email" autoComplete="email" required value={email} onChange={event=>setEmail(event.target.value)}/></label><label>{t('비밀번호','Password')}<input type="password" autoComplete="current-password" required value={password} onChange={event=>setPassword(event.target.value)}/></label>{error&&<p className="error" role="alert">{error}</p>}<button className="primary" type="submit" disabled={busy}>{busy?t('로그인 중…','Signing in…'):t('로그인','Sign in')}</button></form>
    <p className="auth-bottom">{t('아직 계정이 없나요?','New to Peer?')} <a href="/auth/signup">{t('회원가입','Create an account')}</a></p>
  </section></main>;
}
