# Supabase PostgreSQL + Render 전환

이 문서는 배포 대상 선택에 따른 전환 기준이다. 웹 API, 관리자 화면, 예약 만료·민감 데이터 정리 작업은 `DATABASE_URL`이 있으면 PostgreSQL을 사용한다. `DATABASE_URL`이 없으면 기존 SQLite 개발 프리뷰를 유지한다. 실제 Supabase 프로젝트의 마이그레이션·연결과 Render 서비스 생성은 아직 수행하지 않았다.

## 저장소

- Supabase PostgreSQL을 서버의 단일 원본 DB로 사용한다. `supabase/migrations/20261023000100_initial_p2p.sql`은 현재 모델에 대응하는 12개 테이블과 재고·중복 요청 제약, 작업 조회 인덱스를 만든다.
- 테이블은 별도 `p2p` 스키마에 두고 RLS를 켰으며 브라우저용 정책은 만들지 않았다. Supabase Data API에 이 스키마를 노출하지 않는다. 서버가 직접 PostgreSQL에 연결하고 기존 SIWE 세션 및 참가자 권한 검사를 유지한다. Supabase Auth 전환은 이번 단계에 포함하지 않는다.
- 자산 수량은 `numeric(78,0)`으로 저장하고 PostgreSQL 드라이버에서 문자열로 읽어 `BigInt`로 변환한다. 시각은 현재 API와 맞추기 위해 Unix 밀리초 `bigint`, 약정 JSON은 현재 직렬화 형식의 `text`로 둔다.
- 광고 예약 시 **하나의 PostgreSQL 트랜잭션**에서 기존 `(taker, idempotency_key)` 주문을 먼저 확인하고, 광고 조건과 수량을 검증한 뒤 `UPDATE p2p.ads SET available_units=available_units-$1, version=version+1 WHERE id=$2 AND status='ACTIVE' AND available_units >= $1 RETURNING ...`으로 재고를 차감하고 주문·이력을 삽입한다. 주문 삽입이 실패하면 재고 차감도 롤백해야 한다. DB의 재고 범위 제약과 요청 키 UNIQUE는 마지막 안전장치다.
- 새 프로젝트에는 Supabase 마이그레이션으로 스키마를 적용한다. 기존 SQLite 데모 데이터를 옮기려면 별도 검증·이전 절차가 필요하며 이 SQL 파일만 적용해서는 데이터가 이동하지 않는다. 새 PostgreSQL DB에는 데모 광고를 자동으로 넣지 않는다.
- 서버 연결은 `DATABASE_URL`로 선택한다. 연결은 Node `pg` 풀에서 만들고 기본 풀 크기는 프로세스당 5개(`P2P_PG_POOL_MAX`는 1~20)다. Supabase가 제공하는 서버용 PostgreSQL 연결 문자열을 사용하고 외부 연결에는 TLS를 요구하는 URL을 선택한다. `/api/health`는 DB 연결과 `p2p.ads` 스키마 존재 여부를 확인한다.

로컬에서는 Docker와 다음 명령으로 스키마 및 동시 재고 차감 검증을 재현할 수 있다.

```sh
npm run test:postgres-schema
npm run test:postgres-api
```

## Render 배포 설정

저장소 루트의 `render.yaml`은 유료 Starter 요금제의 웹 서비스 `p2p-web`, Background Worker `p2p-reservations`, 매일 03:00 UTC(한국 시간 12:00)에 실행되는 Cron Job `p2p-retention`을 정의한다. 웹은 `npm ci --include=dev && npm run build` 후 `npm run start`로 실행하며 Render의 `PORT`를 사용한다. 웹 상태 확인 경로는 `/api/health`다. 워커는 `npm run reservations:worker`, Cron Job은 `npm run data:prune`을 실행한다. `tsx`가 두 작업의 런타임에 필요하므로 설치 명령에 개발 의존성을 포함한다.

1. Supabase 프로젝트를 만든 뒤 SQL Editor에서 `supabase/migrations/20261023000100_initial_p2p.sql`을 적용한다. 새 DB에는 데모 광고가 없으며 기존 SQLite 데이터도 자동 이전되지 않는다. 적용 후 `p2p.ads` 등 테이블이 생성됐는지 확인한다.
2. Supabase가 제공하는 **서버 전용 PostgreSQL 연결 문자열**을 준비한다. Render에서 접근 가능한 연결 방식(필요하면 Supabase의 IPv4 호환 풀러)을 택하고 TLS가 적용되도록 한다. 서비스 역할 키나 브라우저용 공개 키 대신 DB 연결 문자열을 사용한다.
3. Render Dashboard에서 이 저장소를 Blueprint로 연결하고 `render.yaml`의 세 서비스를 검토한다. 생성 시 세 서비스의 `DATABASE_URL` 비밀 환경 변수에 **동일한 연결 문자열**을 각각 입력한다. `P2P_REQUIRE_POSTGRES=true`가 설정돼 있으므로 URL을 빠뜨리면 SQLite로 조용히 전환되지 않고 시작 또는 상태 확인에 실패한다. 운영자 신고 화면을 사용할 경우 웹 서비스에만 `P2P_ADMIN_ADDRESSES`를 별도로 설정한다.
4. 배포 후 `https://<웹 서비스 주소>/api/health`가 200과 `{"ok":true}`를 반환하는지 확인한다. 워커 로그에 `예약 만료 작업 시작`이 기록되는지 확인하고, Cron Job은 Render에서 수동 실행해 `삭제 완료` 로그와 정상 종료를 확인한다. 세 서비스 모두 같은 DB에 연결해야 한다.

Blueprint 설정만 준비했으며 Supabase 프로젝트의 SQL 실행이나 Render 리소스 생성은 아직 수행하지 않았다. 세 서비스는 유료 리소스이므로 실제 생성 전 Render의 예상 비용을 확인한다. Render가 프로세스를 재시작하므로 로컬용 systemd 유닛은 사용하지 않는다. 체인 인덱서는 `localhost:8545`의 Anvil 31337 전용이라 이 Blueprint에서 실행하지 않는다. 운영 체인·RPC·컨트랙트·토큰을 확정하고 별도 검증한 뒤 배포 방식을 정한다. DB URL, 서비스 역할 키, 비밀 키는 브라우저에 전달하지 않는다.

PostgreSQL 모드의 API·작업 프로세스는 별도 비동기 저장소 구현을 사용한다. 로컬 PostgreSQL 17 통합 시험에서 SIWE 로그인, 광고·주문, 대화·신고·관리자 검토, 예약 만료 작업과 보존 데이터 정리 명령을 확인했다. 두 웹 서버가 같은 DB와 세션을 공유하는 상태에서 16개 HTTP 예약 중 1개만 성공했다. SQLite 경로는 로컬 개발 시험을 위해 유지한다.
