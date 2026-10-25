'use client';
import { useEffect, useState } from 'react';
import { LanguageSelect, useLanguage } from '../../language-provider';

export default function ConfirmPage() {
  const {t}=useLanguage();
  const [status,setStatus]=useState<'working'|'error'>('working');
  useEffect(()=>{
    const params=new URLSearchParams(window.location.hash.slice(1));
    const accessToken=params.get('access_token');
    window.history.replaceState(null,'',window.location.pathname);
    if(!accessToken){setStatus('error');return;}
    void fetch('/api/v1/auth/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accessToken})}).then(response=>{if(!response.ok)throw new Error();window.location.replace('/');}).catch(()=>setStatus('error'));
  },[]);
  return <main className="auth-page"><header className="auth-header"><a className="logo" href="/">peer<span className="logo-dot">.</span></a><LanguageSelect/></header><section className="auth-card"><span className="eyebrow">VERIFY EMAIL</span><h1>{status==='working'?t('이메일을 확인하고 있습니다','Verifying your email'):t('인증 링크를 확인할 수 없습니다','Verification link could not be used')}</h1><p>{status==='working'?t('잠시만 기다려 주세요.','Please wait a moment.'):t('링크가 만료되었거나 이미 사용되었을 수 있습니다. 다시 가입하거나 로그인해 주세요.','The link may have expired or already been used. Please sign up again or sign in.')}</p>{status==='error'&&<a className="auth-link" href="/auth/signup">{t('회원가입으로 돌아가기','Back to sign up')}</a>}</section></main>;
}
