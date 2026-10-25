# Supabase PostgreSQL + Vercel 배포

Vercel 프로젝트 `p2p`의 프로덕션 주소는 `https://p2p-mu.vercel.app/`, Supabase 프로젝트 ref는 `dadnogqummcpfwactszh`입니다. 다음 DB 마이그레이션이 적용되어야 합니다.

- `supabase/migrations/20261023000100_initial_p2p.sql`: 광고·주문·세션·신고 데이터
- `supabase/migrations/20261025000100_member_profiles.sql`: 이메일 인증 회원 프로필

Vercel Production 환경 변수는 다음과 같습니다.

- `DATABASE_URL`: Supabase 서버 전용 PostgreSQL 풀러 연결 문자열. 브라우저에 노출하지 않습니다.
- `SUPABASE_PUBLISHABLE_KEY`: Supabase의 공개 API 키. 회원가입·로그인 요청에 사용합니다.
- `SUPABASE_URL`: 기본값은 이 프로젝트 URL이지만 명시적으로 설정할 수 있습니다.
- `CRON_SECRET`: Vercel Cron 인증용 무작위 값.
- `P2P_ADMIN_USER_IDS`: 신고 검토 운영자 계정의 Supabase Auth UUID 목록. 필요한 경우에만 쉼표로 구분해 설정합니다. 지갑 주소는 허용하지 않습니다.

Supabase Auth에서 이메일 가입을 켜고 **Confirm email**을 유지합니다. `Site URL`은 `https://p2p-mu.vercel.app`, Redirect URLs에는 `https://p2p-mu.vercel.app/auth/confirm`을 등록합니다. 로컬 개발에는 `http://localhost:3000/auth/confirm`도 허용할 수 있습니다. 가입 시 Supabase Auth가 확인 메일을 보내고, 인증 링크를 클릭하면 앱의 `/auth/confirm` 화면이 토큰을 확인한 뒤 앱 세션을 만듭니다. SMS 인증은 사용하지 않습니다. Supabase의 기본 이메일 서비스는 외부 수신자 전송이 제한되므로 공개 가입에는 **Auth → SMTP Settings**에서 커스텀 SMTP 서버를 설정해야 합니다. 비밀번호와 SMTP 인증 정보는 채팅이나 저장소에 넣지 않습니다.

`vercel.json`은 Sydney(`syd1`) 함수 지역과 Vercel Hobby에 맞춘 일일 Cron을 설정합니다. `/api/cron/expire`는 예약·광고 만료를, `/api/cron/retention`은 오래된 대화·신고 내용을 정리합니다. Hobby의 Cron은 하루 한 번 실행될 수 있으므로 접속이 없는 동안 만료 DB 상태 갱신이 늦어질 수 있습니다. 사용자 요청에서도 만료 처리를 실행합니다.

배포 후 `/api/health`가 200인지, 로그인 전 GNB에 P2P 마켓과 광고등록만 표시되는지, 한국어/English 전환이 되는지 확인합니다. 이메일 가입, 미인증 로그인 거부, 인증 링크 사용, 광고 등록·예약도 SMTP를 설정한 후 실제 주소에서 점검합니다.
