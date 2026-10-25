import type { Metadata } from 'next';
import './globals.css';
import { LanguageProvider } from './language-provider';
export const metadata: Metadata = {title: 'Peer — Crypto P2P Market', description: '이메일 인증으로 가입하는 암호화폐 P2P 마켓플레이스'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {return <html lang="ko"><body><LanguageProvider>{children}</LanguageProvider></body></html>;}
