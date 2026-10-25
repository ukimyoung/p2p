# Peer — Crypto P2P Marketplace

Peer는 암호화폐 P2P 광고와 데모 예약을 제공하는 개발 프리뷰입니다. 한국어와 영어를 지원합니다. 가입에는 이메일, 비밀번호, 국가번호를 선택한 전화번호가 필요합니다. Supabase Auth가 이메일 인증 링크를 보내며, 링크로 인증을 마친 사용자만 로그인하고 광고·예약 기능을 사용할 수 있습니다. 전화번호 소유 확인 SMS는 사용하지 않습니다.

광고와 가격은 데모 데이터이며 예약으로 자산이 이동하지 않습니다. 외부 지갑 연결과 브라우저 체인 거래는 서비스에서 제공하지 않습니다. 평판·후기, 위험 안내, FAQ도 MVP 범위에 포함하지 않습니다.

## 실행

Node.js 24와 PostgreSQL이 필요합니다. Supabase 프로젝트에 다음 마이그레이션을 순서대로 적용합니다.

1. [`supabase/migrations/20261023000100_initial_p2p.sql`](supabase/migrations/20261023000100_initial_p2p.sql)
2. [`supabase/migrations/20261025000100_member_profiles.sql`](supabase/migrations/20261025000100_member_profiles.sql)

서버 환경에 `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`를 지정하고 `npm ci && npm run dev`를 실행합니다. `DATABASE_URL`은 서버 전용 연결 문자열이며 Git에 넣지 않습니다. `SUPABASE_PUBLISHABLE_KEY`는 Supabase의 공개 키입니다. Supabase Auth에서 이메일 확인을 켜고 `Site URL`과 Redirect URL에 서비스의 `/auth/confirm` 주소를 등록해야 합니다. 실제 외부 사용자에게 이메일을 보내려면 Supabase Auth의 커스텀 SMTP도 설정해야 합니다.

Vercel 운영 설정은 [배포 문서](docs/supabase-vercel.md)에 있습니다. 프로덕션 주소는 [p2p-mu.vercel.app](https://p2p-mu.vercel.app/)입니다.

## 검증

`npm test`는 도메인 규칙을, `npm run test:postgres-api`는 Docker PostgreSQL에서 이메일 가입·인증·로그인, 광고·예약·신고, 두 웹 서버의 재고 경합을 검증합니다. `npm run build`와 `npm run typecheck`로 빌드와 타입을 확인합니다.

기존 로컬 체인 실험 코드는 연구용 파일로 남아 있지만 웹 서비스의 지갑 연결·체인 API는 제거했습니다.
