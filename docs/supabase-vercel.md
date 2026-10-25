# Supabase PostgreSQL + Vercel 배포

웹 API와 관리자 화면은 Supabase PostgreSQL을 사용한다. 프로젝트 `dadnogqummcpfwactszh`에는 `supabase/migrations/20261023000100_initial_p2p.sql`을 이미 적용했다. 12개 테이블에 RLS가 켜져 있고 브라우저 역할의 `p2p` 스키마 접근은 허용하지 않았다. 기존 SQLite 개발 데이터는 이전하지 않았으며 새 DB에는 데모 광고가 자동으로 추가되지 않는다.

## Vercel 구성

- 이 저장소는 Next.js 앱으로 가져온다. Root Directory는 저장소 루트이며 빌드 명령은 `npm run build`다. Node.js 24를 사용한다.
- Production 환경 변수 `DATABASE_URL`에 Supabase의 **서버 전용 PostgreSQL 연결 문자열**을 넣는다. Vercel의 여러 함수 인스턴스가 같은 DB를 사용해야 하므로 서버리스 연결에 적합한 Supabase 풀러를 사용한다. 브라우저 공개 키나 Supabase 서비스 역할 키로 대체하지 않는다. Supabase 호스트 연결은 공식 Supabase 생산 환경 루트 CA(2021·2025)와 서버 호스트명으로 TLS 인증서를 검증하며, Vercel에서는 함수 인스턴스당 PostgreSQL 풀 연결을 기본 1개로 제한한다.
- Production 환경 변수 `CRON_SECRET`에 추측하기 어려운 임의 값을 넣는다. Vercel Cron은 이 값을 `Authorization: Bearer ...` 헤더로 보내며, 두 작업 경로는 값이 없거나 일치하지 않으면 실행하지 않는다. 토큰과 연결 문자열을 Git이나 채팅에 넣지 않는다.
- `P2P_ADMIN_ADDRESSES`는 관리자 신고 화면을 사용할 때만 웹 서비스에 설정한다. `P2P_REQUIRE_POSTGRES`는 Vercel에서 자동으로 적용되며, `DATABASE_URL`이 빠지면 SQLite 파일로 전환하지 않고 실패한다.
- Vercel Cron은 상시 실행 프로세스가 아니다. `/api/cron/expire`가 예약·광고 만료를, `/api/cron/retention`이 오래된 대화·신고 내용을 정리한다. `vercel.json`은 Hobby에서도 배포할 수 있도록 두 작업을 각각 매일 03:00·03:05 UTC(한국 시간 12:00·12:05)에 예약한다. Hobby의 실제 호출 시각은 해당 시간대 안에서 달라질 수 있다. 만료 처리는 사용자 요청에서도 즉시 수행되지만, 접속이 없는 동안 DB 상태 갱신은 다음 일일 Cron까지 지연될 수 있다. 짧은 주기의 무요청 만료가 필요하면 Vercel Pro의 Cron 빈도 제한과 비용을 확인한 뒤 만료 작업을 1분 주기로 바꾼다.

## 배포와 확인

1. Vercel에 GitHub 저장소 `ukimyoung/p2p`를 연결하고 Production 환경 변수 `DATABASE_URL`, `CRON_SECRET`을 입력한다. `vercel.json`은 함수 지역을 Supabase 프로젝트의 `ap-southeast-2`와 같은 Sydney(`syd1`)로 지정한다.
2. 배포 후 `https://<프로덕션 주소>/api/health`가 200과 `{"ok":true}`를 반환하는지 확인한다. 이 응답은 DB 연결과 `p2p.ads` 존재를 확인한다.
3. Cron 경로를 인증 없이 호출하면 401이어야 한다. Vercel의 Cron 실행 로그에서 두 작업이 200으로 끝나는지 확인한다. 예약 만료 작업은 여러 호출이 겹쳐도 PostgreSQL 트랜잭션을 통해 재고를 한 번만 복구한다.
4. 브라우저에서 광고 목록, 지갑 로그인, 광고 등록·예약·수락·만료를 실제 배포 주소로 점검한다. 로컬 Anvil 31337 체인 경로는 Vercel 배포 대상이 아니다.

현재 Codex 실행 환경은 Supabase PostgreSQL 호스트의 직접 DNS 조회가 `EAI_AGAIN`으로 실패한다. 스키마는 Supabase Management API로 확인했지만 Vercel 배포 후의 앱 연결·Cron 실행은 아직 검증하지 않았다.
