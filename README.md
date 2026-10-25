# Peer — Crypto P2P Marketplace

Supabase PostgreSQL·Vercel 배포 상태와 운영 절차는 [Supabase/Vercel 배포 문서](docs/supabase-vercel.md)에 정리했습니다. [Vercel 프로덕션 서비스](https://p2p-mu.vercel.app/)는 Supabase 프로젝트에 적용한 초기 스키마를 사용합니다. `DATABASE_URL`을 지정하면 웹 API와 예약 만료 작업이 PostgreSQL을 사용합니다.

암호화폐 전용 P2P 웹서비스의 개발 프리뷰입니다. PRD를 기반으로 광고 탐색·관리, SIWE 지갑 로그인, 데모 주문 예약과 광고주의 수락·거절, 주문 상태 이력·주문별 대화·신고·차단을 구현했습니다. 광고와 가격은 예시이며 일반 데모 예약은 자산을 이동하지 않습니다. 평판·후기는 MVP 범위에서 제외했습니다.

수락한 ETH 데모 주문은 선택적으로 로컬 Anvil 체인의 WETH/USDC 테스트 토큰 주문으로 전환할 수 있습니다. 양측 EIP-712 서명, 승인, Maker 선예치, Taker 예치와 원자적 정산, 취소·만료·환불을 브라우저 지갑으로 시험합니다. 이 경로는 31337 로컬 체인에만 열립니다.

## 개발

Node.js 24, npm 사용. 외부 서비스나 API 키는 필요하지 않습니다. 브라우저 지갑 로그인에는 Sepolia 네트워크가 필요하며, 이 선택은 로그인 테스트용이고 출시 체인 결정이 아닙니다. 로컬 체인 주문에서는 같은 로그인 계정을 Anvil 31337로 전환합니다.

```sh
npm ci
npm run dev
```

기본 포트는 3000입니다. `DATABASE_URL`이 없으면 서버는 `.data/p2p.sqlite`에 데모 광고, 일회용 로그인 요청, 세션, 예약을 저장합니다. 로컬 DB 경로를 바꾸려면 서버 시작 시 `P2P_DB_PATH=/tmp/p2p-demo.sqlite npm run dev`를 사용하세요. 이 파일은 Git에서 제외됩니다.

PostgreSQL 모드에서는 [초기 마이그레이션](supabase/migrations/20261023000100_initial_p2p.sql)을 별도로 적용하고, 웹과 예약 만료 작업에 같은 서버 전용 `DATABASE_URL`을 설정합니다. 새 PostgreSQL DB는 데모 광고를 자동으로 추가하지 않습니다. DB와 스키마까지 확인하는 `/api/health`가 200을 반환해야 합니다. 로컬 PostgreSQL 통합 시험은 Docker에서 `npm run test:postgres-api`로 실행할 수 있습니다.

### 예약 만료 작업

웹 서버가 DB를 생성한 뒤 별도 터미널에서 아래 작업을 실행하면, 조회 요청이 없어도 예약·수락 주문과 광고의 기한을 주기적으로 처리합니다. 웹 서버와 **같은 SQLite 파일**을 지정해야 합니다.

```sh
P2P_DB_PATH="$PWD/.data/p2p.sqlite" npm run reservations:worker
```

시작 직후 한 번 실행하고 이후 기본 30초 간격으로 반복합니다. `P2P_EXPIRY_INTERVAL_MS`로 간격을 바꿀 수 있습니다(100ms 이상). 작업이 일시적으로 실패하면 오류를 기록하고 다음 주기에 다시 시도합니다. 여러 웹 서버나 작업 프로세스가 같은 DB를 사용해도 기존 SQLite 트랜잭션이 만료와 잔량 복구를 한 번만 반영합니다. 별도 프로세스이므로 서비스 실행 환경에서는 웹 서버와 함께 실행하고 재시작하도록 구성해야 합니다. 로컬 체인 주문의 체인 로그 동기화는 이 작업의 범위에 포함되지 않습니다.

### 로컬 체인 거래 시험

새 Anvil 인스턴스마다 테스트 컨트랙트를 다시 배포해야 합니다. 첫 터미널에서 `npm run chain:anvil -- --silent`를 실행합니다. 두 번째 터미널에서 아래 명령을 실행한 뒤, 같은 환경 변수로 웹 서버를 시작합니다.

```sh
cd /workspace/p2p
export P2P_CHAIN_DIR="$(mktemp -d /tmp/p2p-chain.XXXXXX)"
export P2P_CHAIN_ENV_PATH="$P2P_CHAIN_DIR/chain.env"
npm run chain:setup
set -a
. "$P2P_CHAIN_ENV_PATH"
set +a
P2P_DB_PATH="$P2P_CHAIN_DIR/p2p.sqlite" npm run dev
```

`chain:setup`은 로컬 테스트 USDC/WETH와 에스크로를 배포하고 첫 세 Anvil 지갑에 테스트 토큰을 발행합니다. 자신의 테스트 전용 지갑에 토큰이 필요하면 위 설정 파일을 읽은 터미널에서 `npm run chain:mint -- 0x본인지갑주소`를 실행하세요. 설정 파일은 Git에 넣지 않습니다. 브라우저 지갑에는 로컬 RPC `http://127.0.0.1:8545`, 체인 ID `31337`을 추가하고, **본인 소유의 테스트 전용 계정**만 사용하세요. `chain:mint`은 가스용 로컬 ETH 1개도 보냅니다. SIWE 로그인은 Sepolia에서 마친 다음 같은 계정을 로컬 체인으로 전환합니다. Maker 광고를 만들고 Taker가 ETH 주문을 예약한 뒤 Maker가 수락하면 양쪽 주문 목록에 로컬 체인 패널이 나타납니다. 각 당사자는 표시된 토큰 주소·예치량·수취량·수수료를 확인하고 서명합니다. 이 체인은 테스트 토큰 전용이며 재시작하면 상태가 사라집니다.

### 체인 로그 동기화 작업

로컬 체인을 설정한 뒤 별도 터미널에서 **웹 서버와 같은 체인 설정·SQLite DB 경로**를 지정해 실행합니다. 위 예시에서 만든 `chain.env`와 DB 경로를 사용하세요.

```sh
set -a
. /path/to/chain.env
set +a
P2P_DB_PATH=/path/to/p2p.sqlite npm run chain:worker
```

시작 직후 한 번 동기화하고 이후 기본 5초 간격으로 확정된 체인 로그와 체크포인트를 갱신합니다. `P2P_CHAIN_SYNC_INTERVAL_MS`로 간격을 바꿀 수 있습니다(100ms 이상). RPC 장애나 재고 충돌이 발생하면 오류를 기록하고 다음 주기에 재시도하며, 실패한 주기의 DB 변경은 롤백됩니다. 웹 서버가 여러 개여도 기존 체크포인트 경합 보호 로직을 사용합니다. 예약 만료는 별도의 `reservations:worker`가 담당하므로 두 작업을 같은 DB에 연결해 함께 실행·감시해야 조회 없이 재고 충돌에서 복구할 수 있습니다. 이 작업은 로컬 Anvil 개발 프리뷰 전용입니다.

### 작업 프로세스 감독과 상태 확인

웹 서버가 DB를 생성한 뒤 로컬 체인 설정을 읽은 터미널에서 같은 DB를 지정하고 아래 명령을 실행하면 예약 만료와 체인 동기화 작업을 함께 시작합니다. 작업 프로세스가 비정상 종료되면 1초부터 최대 30초까지 간격을 늘려 재시작합니다. 같은 DB에 감독 프로세스를 둘 이상 실행하지 않도록 잠금 파일을 사용합니다.

```sh
P2P_DB_PATH=/path/to/p2p.sqlite npm run workers:start
```

다른 터미널에서 같은 DB 경로로 상태를 확인할 수 있습니다.

```sh
P2P_DB_PATH=/path/to/p2p.sqlite npm run workers:status
```

상태 명령은 감독 프로세스와 각 작업의 PID, 마지막 실행·성공 시각, 오류, 재시작 횟수를 JSON으로 출력합니다. 두 작업이 살아 있고 최근 실행이 성공했을 때 종료 코드 0, 재시작 중이거나 실패·정지·응답 지연 상태일 때 1을 반환합니다. 상태 파일은 DB 옆의 `p2p.sqlite.workers.json`에 제한된 파일 권한으로 기록됩니다. 감독 프로세스 자체가 중단되면 상태 명령이 비정상을 보고하므로 실제 실행 환경에서는 감독 프로세스를 재시작하는 서비스 관리자도 필요합니다.

### 감독 프로세스의 systemd 재시작

Linux systemd 사용자 서비스로 감독 프로세스 자체를 종료 후 5초 뒤 다시 시작할 수 있습니다. 웹 서버가 DB를 만든 뒤 **같은 DB 경로**와 `chain:setup`에서 생성한 **같은 체인 설정 파일**의 절대 경로를 지정하세요. 지속해서 사용할 호스트에서는 재부팅 후에도 남는 경로를 사용합니다.

```sh
export P2P_DB_PATH=/absolute/path/to/p2p.sqlite
export P2P_CHAIN_ENV_PATH=/absolute/path/to/chain.env
npm run workers:service:render -- \
  --db "$P2P_DB_PATH" \
  --chain-env "$P2P_CHAIN_ENV_PATH" \
  --output "$PWD/.data/p2p-workers.service"
systemd-analyze verify "$PWD/.data/p2p-workers.service"
mkdir -p "$HOME/.config/systemd/user"
install -m 600 "$PWD/.data/p2p-workers.service" "$HOME/.config/systemd/user/p2p-workers.service"
systemctl --user daemon-reload
systemctl --user enable --now p2p-workers.service
systemctl --user status p2p-workers.service
P2P_DB_PATH="$P2P_DB_PATH" npm run workers:status
```

서비스 파일에는 현재 프로젝트·Node 실행 파일의 절대 경로와 DB 경로가 기록되고, 체인 설정은 원본 `chain.env`에서 시작할 때 읽습니다. 프로젝트·Node·DB·설정 파일 위치를 바꾸면 서비스를 다시 생성·설치하고 `daemon-reload`와 `restart`를 실행하세요. 체인 설정 내용만 바꾸면 `systemctl --user restart p2p-workers.service`로 다시 읽을 수 있습니다. 사용자 서비스는 해당 사용자의 systemd 관리자가 실행 중이어야 하며, 로그인하지 않은 상태의 자동 시작이 필요하면 호스트에서 사용자 linger 설정이 필요합니다. Anvil과 웹 서버는 별도로 실행해야 합니다.

실제 systemd 호스트에서 재시작을 확인할 때는 Anvil·웹 서버·서비스를 실행한 상태에서 아래 명령을 사용합니다. 감독 프로세스를 강제 종료하므로 테스트 DB에서만 실행하세요. 새 PID와 활성 상태를 확인한 뒤 `workers:status`가 종료 코드 0을 반환하면 두 작업의 복구까지 확인된 것입니다.

```sh
old_pid=$(systemctl --user show -p MainPID --value p2p-workers.service)
kill -KILL "$old_pid"
sleep 10
new_pid=$(systemctl --user show -p MainPID --value p2p-workers.service)
test "$new_pid" -gt 0 && test "$new_pid" != "$old_pid"
systemctl --user is-active p2p-workers.service
P2P_DB_PATH=/absolute/path/to/p2p.sqlite npm run workers:status
```

## 검증

```sh
npm test
npm run test:contracts
npm run test:concurrency
npm run test:indexer-recovery
npm run test:expiry-worker
npm run test:browser
npm run test:chain
npm run typecheck
npm run build
npm start
```

실제 HTTP 서명·예약 흐름을 점검하려면 별도 터미널에서 개발 서버를 실행한 뒤 `P2P_TEST_BASE_URL=http://localhost:3000 npm run test:api`를 실행하세요. 테스트는 임시 지갑으로 데모 광고, 예약, 수락·거절, 참가자 전용 대화·신고·차단, 이력, 취소를 검증합니다. 운영 데이터와 분리된 `P2P_DB_PATH`로 서버를 시작하세요.

`npm run test:browser`는 위 로컬 Anvil·웹 서버가 실행 중일 때 사용합니다. Playwright Chromium으로 독립된 두 브라우저 세션에 **테스트 전용 지갑 제공자**를 주입해 광고 등록부터 정산까지 화면을 조작합니다. 양측 주문 대화·신고·차단, 차단 후 기존 주문 정산, 서명 거절, 가스비 견적 실패 시 전송 차단과 추가 확인, 확정 실패 거래 재시도, 네트워크 변경 시 버튼 잠금, 계정 변경 시 세션 종료, 2분 이상 지연 거래의 저장·nonce 취소 감지·재시도를 확인합니다. 미확인 거래의 해시와 nonce는 브라우저 로컬 저장소에 남으며, 지갑에서 거래 속도를 높이거나 취소한 뒤 패널에서 다시 확인할 수 있습니다. 시스템 Chromium이 없으면 `npx playwright install chromium`을 실행하세요. 다른 위치의 브라우저를 쓰려면 `P2P_CHROMIUM_PATH`를 지정합니다. 새 SQLite DB로 실행하고 `test:chain`보다 먼저 돌립니다.

`npm run test:concurrency`는 빌드 후 두 개의 웹 서버를 임시 포트에서 실행하고 하나의 임시 SQLite DB를 공유합니다. 광고당 1건 또는 2건의 주문만 수용할 수 있도록 설정한 뒤, 서로 다른 4개 지갑의 HTTP 예약 요청을 16회 동시에 보냅니다. 서버별 잔량과 주문 수, 반대 서버에서 같은 요청 키로 재시도했을 때의 멱등성을 확인합니다. 테스트가 끝나면 서버와 임시 DB를 정리합니다. 이 검증은 로컬 SQLite 예약 경합에 한정됩니다.

`npm run test:indexer-recovery`는 빌드 후 임시 Anvil·SQLite·웹 서버와 RPC 프록시를 자동으로 실행합니다. 서버 재시작, RPC 장애 후 따라잡기, 두 서버의 오래된 스캔과 동시 동기화, 체크포인트 삭제 후 로그 재처리에서 주문·재고의 일관성을 확인합니다. 이어 확정 블록 수 2에서 개설·Maker 예치·정산의 반영 경계, 미확정 블록 소실, 이미 반영한 정산 블록의 깊은 재구성을 검사합니다. 취소로 풀린 광고 수량을 다른 지갑이 모두 예약한 뒤 취소 블록이 사라지는 재고 충돌도 재현합니다. 이때 동기화는 503을 반환하고 DB를 부분 변경하지 않으며, 경쟁 예약이 취소되거나 응답 기한에 만료된 뒤 다시 동기화하면 원래 주문과 잔량을 복구합니다. 만료는 주문 조회와 독립 작업 프로세스 경로를 각각 검사합니다. 이어 체인 동기화·예약 만료 작업을 함께 실행해, 웹 조회 없이 취소 로그를 반영하고 깊은 재구성의 재고 충돌 이후 두 작업이 자동으로 원래 주문과 잔량을 복구하는지 확인합니다. 한 체인 작업을 이전 체크포인트를 읽은 상태에서 일시 정지하고, 재시작한 다른 작업이 새 블록을 먼저 저장하게 만든 뒤 재개해 재고·이력·체크포인트의 중복 반영 여부를 확인합니다. 마지막으로 감독 프로세스 아래의 두 작업을 각각 강제 종료해 재시작·상태 조회·새 블록 따라잡기를 검증합니다. 만료 시험은 임시 DB의 응답 기한을 지난 시각으로 설정합니다. 테스트가 끝나면 임시 프로세스와 DB를 정리합니다.

`npm run test:expiry-worker`는 임시 SQLite DB를 공유하는 독립 작업 프로세스 둘을 실행합니다. 웹 요청 없이 응답 대기·수락 주문과 광고의 기한을 경과시켜 만료를 기다리고, 재고·상태 이력이 한 번만 변경되는지 반복 주기까지 검사합니다.

`npm run test:chain`은 **새 Anvil 체인과 별도 SQLite DB**를 사용하는 서버(`P2P_TEST_BASE_URL`, 기본 `http://localhost:3011`)가 실행 중일 때 호출합니다. 테스트는 Anvil 기본 계정 1·2를 사용하며 테스트 토큰이 발행되어 있어야 합니다. 양측 서명, 승인·정산, 취소·환불, 확정 로그 인덱싱, 체인 재구성 시 재고 되돌리기, 서명 만료 재고 복구와 10,000블록 이상 지난 뒤 동기화를 확인합니다. 이 테스트는 Anvil 시간을 이동시키므로 마지막에 실행하고, 재실행하려면 Anvil과 테스트 DB를 새로 시작하세요.

`npm run test:contracts`는 npm에 고정한 Foundry 바이너리와 Solidity 0.8.30 컴파일러로 에스크로 상태 전이를 검증합니다. Maker 선예치, 양방향 원자적 교환, 단방 예치 환불, EIP-712 서명·nonce, 정확한 토큰 수량, 기한, 정지 중 환불을 포함합니다. Foundry와 컴파일러는 `npm ci`로 설치되며 별도의 전역 설치가 필요하지 않습니다.

### 신고 검토 개발 프리뷰

서버 시작 전에 `P2P_ADMIN_ADDRESSES=0x운영자지갑주소`를 지정합니다. 쉼표로 여러 주소를 구분할 수 있습니다. 허용 목록이 비어 있거나 잘못되면 운영자 API 접근을 막습니다. 해당 지갑으로 홈에서 SIWE 로그인한 뒤 `/admin/reports`에 접속하면 대기 신고 목록, 신고 내용, 관련 주문 상태와 보존 중인 대화를 확인하고 ‘확인됨’ 또는 ‘기각’으로 처리할 수 있습니다. 결과와 운영자 주소, 처리 시각, 메모를 신고 기록에 함께 저장합니다. 참가자는 자신의 신고 결과만 볼 수 있고 운영자 메모는 볼 수 없습니다. 심사 결과는 계정 차단이나 온체인 거래에 영향을 주지 않습니다.

HTTP 통합 테스트는 별도 DB와 포트 3012에서 서버를 시작한 뒤 `npm run test:admin`을 실행합니다. 테스트 전용 운영자 주소는 `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`이며, 서버의 `P2P_ADMIN_ADDRESSES`에 설정해야 합니다. 이 주소는 공개된 테스트 키에 대응하므로 격리된 로컬 테스트에서만 사용합니다.

### 대화·신고 데이터 보존

개발 프리뷰는 주문이 종료되면 대화 내용을 30일, 신고 내용을 180일 보존합니다. 종료 후 30일이 지나면 새 신고를 받지 않습니다. 진행 중인 주문의 기록과 주문 상태 이력, 차단 설정은 이 정리 대상이 아닙니다. 해당 주문을 조회하면 만료된 내용을 정리하며, 접근하지 않는 주문까지 정리하려면 매일 별도로 다음 명령을 실행하세요.

```sh
P2P_DB_PATH=/path/to/p2p.sqlite npm run data:prune
```

명령은 기존 DB 경로를 요구하고 삭제 건수를 출력한 뒤 SQLite WAL을 정리합니다. SQLite의 `secure_delete`를 켜 삭제된 레코드가 DB 파일의 빈 공간에 남지 않도록 합니다. 별도 DB 백업에도 같은 보존 정책을 적용해야 합니다. 운영용 보존 기간과 법적 보존·분쟁 예외는 아직 결정되지 않았습니다.

## 현재 동작

- MKT-01/02: 광고 목록, 자산·금액 필터, 유리한 가격순·거래 가능 수량 많은 순·최근 등록순 정렬, 조건 확인. 신규 광고의 등록 시각과 순서를 저장하며, 이전 광고는 알 수 없는 등록 시각을 추정하지 않고 기존 저장 순서로 정렬합니다. 가상의 거래 건수·완료율 표시와 평판 정렬은 제거했습니다.
- MKT-03/04 일부: 로그인한 광고주의 데모 광고 등록·수정·일시중지·재개·종료와 유효기간 관리. 서버가 지갑 소유권과 수정 버전을 확인하고, 예약된 수량보다 총량을 줄이지 못하게 합니다. 기존 주문의 약정 조건은 보존합니다. 신규 광고 유효기간은 1~168시간이며 만료 후 검색과 예약에서 제외됩니다.
- WAL-01 일부: 브라우저 EVM 지갑의 Sepolia SIWE 서명 로그인. 5분 nonce, 도메인 바인딩, 재사용 방지, 24시간 HttpOnly 세션. 현재 EOA 지갑만 검증합니다.
- ORD-01/02 일부: 로그인 사용자가 데모 예약을 요청하면 광고 설정에 따라 5~60분의 광고주 응답 기한이 시작됩니다. 광고주가 수락하면 15분 뒤 만료되고, 거절·거래자 취소·기한 만료 시 잔량이 복구됩니다. 양측은 주문 상태 이력을 볼 수 있습니다. 서버가 가격·수수료·한도·가용량을 다시 계산하고 SQLite 트랜잭션으로 잔량을 예약합니다. 요청 키 재사용도 처리합니다. 연결된 광고주 지갑이 없는 예시 광고는 수락할 수 없고 응답 기한에 만료됩니다.
- ORD-07 일부: 양쪽 거래 목록에서 전체·진행 중·완료·종료/환불 상태를 건수와 함께 필터링합니다. 상태 타임라인은 변경 주체와 시각을 표시합니다. 필터는 새로고침 후에도 유지됩니다.
- ORD-03~05 로컬 체인 프로토타입: 수락한 ETH 주문만 로컬 WETH/USDC로 전환합니다. 두 지갑의 주문별 EIP-712 서명 후 에스크로를 열고, 정확한 ERC-20 수량 승인·Maker 선예치·Taker 예치와 동시 정산, 미이행 취소·환불을 실행합니다. 거래 전 현재 RPC의 가스 사용량·단가로 예상 ETH 비용을 표시하고 사용자가 한 번 더 확인합니다. 견적 실패 또는 1분 경과 시 전송하지 않으며 실제 비용은 지갑에서 최종 확인합니다. 서버는 확인된 계약 로그를 SQLite에 투영하고 재구성 시 재계산합니다. 서명 기한이 지난 미개설 주문은 온체인 미개설을 확인한 뒤 재고를 복구합니다. 지갑 거래 해시와 nonce는 브라우저 로컬 저장소에 보존되며, 확인 지연 중 재전송을 막고 확정 실패 후 상태를 다시 읽어 재시도할 수 있습니다.
- TRU-01 개발 프리뷰: 양 당사자는 주문별 메시지와 시스템 상태 이력을 조회합니다. 3초 간격으로 새 내용을 확인하며, 메시지 전송은 주문 참가자만 가능합니다. 본문은 1000자, 주문당 500건, 발신자별 2초 간격으로 제한하고 요청 ID 재사용 시 중복 저장하지 않습니다. 종료된 주문은 읽기 전용입니다. 메시지는 로컬 SQLite에 평문으로 저장되고 종료 30일 후 정리됩니다. 운영 암호화 정책은 미확정입니다.
- TRU-03 개발 프리뷰: 주문 참가자가 상대방을 주문당 한 번 신고할 수 있습니다. 허용된 운영자 지갑은 신고 근거와 대화를 보고 결과·메모를 기록합니다. 상대방 차단은 양쪽의 새 광고 예약을 막고 해당 광고를 로그인한 사용자에게 숨깁니다. 기존 주문의 대화·상태 조회·환불은 유지합니다. 신고와 심사 내용은 주문 종료 180일 후 정리되며 심사 결과에 따른 자동 제재는 없습니다.
- API: 기존 광고·인증·주문 API에 `GET /api/v1/chain/config`, `GET/POST /api/v1/orders/{id}/chain`, `GET/POST /api/v1/orders/{id}/messages`, `GET/POST /api/v1/orders/{id}/safety`, 운영자 전용 `GET /api/v1/admin/reports`, `GET/POST /api/v1/admin/reports/{id}`를 추가했습니다. 모든 변경 요청에는 같은 출처의 JSON 요청이 필요합니다. 예약 생성에는 `Idempotency-Key` 헤더가 필요합니다.

운영 국가·체인·토큰·수수료·중재 정책은 결정 전입니다. 광고 등록 시 담보·잔액 검증, KYC, 실제 토큰 배포, 운영 인덱서·감사·장애 대응은 아직 없습니다. 로컬 인덱서는 확인된 블록 체크포인트를 SQLite에 저장하고 새 블록만 이어 읽습니다. RPC가 끊기면 저장된 상태를 변경하지 않고 오류를 반환하며, 재연결 시 다시 동기화합니다. 블록 재구성이 감지되면 공통 체크포인트부터 로그와 주문·재고 상태를 재계산합니다. 여러 웹 서버가 한 DB를 공유할 때는 스캔 직후 체인 높이와 저장 직전 DB 체크포인트를 확인하고, 다른 서버가 먼저 상태를 갱신했으면 새로 스캔합니다. 데모 수락만으로 자산은 이동하지 않습니다. 실제 가치가 있는 자산에는 사용하지 마세요.

[범위 및 후속 개발 계획](docs/phase-0.md)과 [테스트넷 에스크로 설계안](docs/testnet-escrow-design.md)을 확인하세요.
