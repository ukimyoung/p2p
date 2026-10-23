import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {title: 'Peer — 암호화폐 P2P 마켓', description: '개인지갑 기반 암호화폐 P2P 마켓플레이스 UX 프로토타입'};
export default function RootLayout({children}: Readonly<{children: React.ReactNode}>) {return <html lang="ko"><body>{children}</body></html>;}
