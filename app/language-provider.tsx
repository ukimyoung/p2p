'use client';
import { createContext, useContext, useEffect, useState } from 'react';
import type { Language } from '../lib/i18n';

type LanguageContext={language:Language;setLanguage:(language:Language)=>void;t:(ko:string,en:string)=>string;locale:string};
const context=createContext<LanguageContext|null>(null);

export function LanguageProvider({children}:{children:React.ReactNode}) {
  const [language,setLanguageState]=useState<Language>('ko');
  useEffect(()=>{
    const saved=localStorage.getItem('peer-language');
    if(saved==='ko'||saved==='en') setLanguageState(saved);
  },[]);
  useEffect(()=>{document.documentElement.lang=language;},[language]);
  function setLanguage(value:Language) {localStorage.setItem('peer-language',value);setLanguageState(value);}
  const t=(ko:string,en:string)=>language==='ko'?ko:en;
  return <context.Provider value={{language,setLanguage,t,locale:language==='ko'?'ko-KR':'en-US'}}>{children}</context.Provider>;
}

export function useLanguage() {
  const value=useContext(context);
  if(!value) throw new Error('LanguageProvider가 필요합니다.');
  return value;
}

export function LanguageSelect() {
  const {language,setLanguage}=useLanguage();
  return <select className="language-select" aria-label="Language / 언어" value={language} onChange={event=>setLanguage(event.target.value as Language)}><option value="ko">한국어</option><option value="en">English</option></select>;
}
