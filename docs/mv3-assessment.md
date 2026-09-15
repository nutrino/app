# MV3 조사 및 단계별 진행 기록

조사일: 2026-09-14. 원격 저장소를 fetch한 뒤 아래 커밋을 기준으로 확인했다.

- 과거 시도: `origin/codex` — `5f18ef9fb5e0a6f213e2b69d50ade44a0f8d07c3` (2025-10-11).
- upstream: `upstream/manifest-upd` — `264cddb2ab64a87e955578dbb49d1895c854b4be` (2026-03-20).
- 새 작업 브랜치: `mv3-codex`, 시작점은 복구된 master `286a07c`.

## 1단계 — 비교 및 보안 조사 완료

### 과거 codex가 실패할 수밖에 없었던 구조

`chromium-service-worker.ts`는 Angular 백그라운드를 offscreen 문서에 올리고
메시지를 중계한다. 그러나 offscreen 문서는 확장 API 중 runtime만 지원한다.
그 안의 `WebExtBackgroundService`와 bookmark/platform 서비스는 여전히
bookmarks, alarms, notifications 등을 직접 사용한다. 일부 이벤트를 워커로
옮겨도 북마크 조회/변경 등의 호출은 실행되지 않는다.

`waitForOffscreenReady()`와 `pendingRequests`에 타임아웃이 없고, bridge는
`backgroundSvc.init()` 완료를 기다리기 전에 ready를 보낸다. 초기화 실패와
워커 종료/재기동 시 대기 또는 상태 불일치가 발생할 수 있다. fallback 창은
일반 문서이므로 다른 동작을 보여 이 결함을 가릴 수 있다. 이는 과거 실행
로그를 확보한 사후 분석이 아니라, 당시 최종 소스에서 확인한 실패 원인이다.

근거: [Chrome offscreen 문서](https://developer.chrome.com/docs/extensions/reference/api/offscreen).

### upstream 최신 커밋은 안정적인 MV3 버전인가?

아니다. manifest 원본은 V2지만 webpack이 Chromium은 V3 service_worker,
Firefox는 V3 background.scripts로 변환한다. manifest 숫자만 본 판단은 아니다.

의존성 설치 스크립트를 비활성화하고 잠금 파일 그대로 설치한 뒤 Chromium
개발 빌드는 성공했다. 하지만 생성한 background.js를 DOM 없는 격리 환경에서
실행하면 다음 오류로 이벤트 리스너 등록 전에 중단됐다.

```
Error: Service 'PlatformService' not registered in background injector
```

`background-container.ts`가 PlatformService를 필요로 하는 BookmarkService를
먼저 생성하기 때문이다. 또한 다음 문제가 남아 있다.

- NetworkService의 무조건적인 `window` 접근, UtilityService URL 파싱의 DOM 의존.
- 워커 재기동 때는 onInstalled/onStartup이 항상 발생하지 않는데, 초기화가
  그 이벤트에만 연결돼 있다. 북마크 리스너도 비동기적으로 등록한다.
- 동기화 큐와 이벤트 큐가 메모리에 있어 워커 중단 시 복구를 보장하지 못한다.
- 다운로드가 서비스 워커에 없는 `URL.createObjectURL()`에 의존한다.
- HTTP shim은 Promise 기반 취소를 처리하지 않으며 응답 본문을 읽기 전에
  타임아웃을 해제한다. timeout shim은 콜백의 동기 예외를 Promise에 전달하지 않는다.
- 사용자 지정 동기화 서버에 대한 MV3 호스트 권한 요청/거부/재시작 검증이 필요하다.

근거: [Chrome 워커 수명주기](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

### 보안 검토 범위와 결론

양 브랜치의 자체 소스, manifest, 빌드 스크립트, 외부 통신 경로와 잠금 파일을
정적으로 확인했다. 채굴기, 키로거, 브라우저 저장 비밀번호 수집, 비밀을 별도
목적지로 보내는 코드는 발견하지 못했다. 이것이 무해함을 보증하거나 전체
의존성/배포 바이너리/서버의 안전성을 증명하는 것은 아니다.

- Web Crypto의 PBKDF2-SHA256(250,000회), AES-GCM(256비트)을 사용한다.
  서버 전송 경로는 동기화 ID 및 암호화된 북마크를 다룬다.
- 원문 비밀번호 대신 파생된 암호화 키를 로컬 IndexedDB에 저장한다. 이 키도
  복호화 가능한 비밀이므로 프로필 탈취나 확장 내부 XSS는 위험하다.
- 선택적 telemetry는 ID/password를 제외하지만 설치 식별자·설정·서비스 정보를
  보낼 수 있다. 현재 코드를 완전히 무통신 또는 완전히 익명이라고 보지 않는다.
- HTTP 서버 연결은 TLS가 없어 ID/메타데이터 관찰, 응답 변조 및 재생 위험이
  남는다. 북마크 자체의 AES-GCM 암호화와 전송 계층 보호는 별개다.
- upstream 잠금 파일의 모든 resolved 패키지 주소는 npm 공식 registry였으나,
  npm audit 결과 25개 취약 패키지(critical 1, high 13, moderate 8, low 3)가 있었다.
  critical인 handlebars는 개발 도구 의존성이다. 개수는 실제 악용 가능성을 뜻하지 않는다.
- 호환 범위 안의 `npm audit fix --ignore-scripts` 후 5개(고위험 1, 중간 4)가
  남는다: angular, angular-filter, angular-hammer, angular-sanitize,
  angular-ts-decorators. AngularJS 제거/대체 또는 별도 완화 검증이 필요하다.
  audit가 제안하는 오래된 버전으로의 강제 다운그레이드는 적용하지 않았다.

참조: [AngularJS XSS](https://github.com/advisories/GHSA-prc3-vjfx-vhm9),
[angular-sanitize](https://github.com/advisories/GHSA-4p4w-6hg8-63wx).

## 2단계 — MV3 빌드 및 초기 실행 기반

- upstream 변경을 병합하고 master의 Firefox 오류 처리/개발 HTML 수정을 유지.
- DI 생성 순서를 수정해 Chromium/Firefox의 백그라운드 시작 오류 해결.
- 네트워크 상태 확인과 URL 파싱에서 불필요한 window/DOM 의존 제거.
- `--env outputRoot=...`로 현재 사용 중인 Firefox 빌드를 덮어쓰지 않고 검증.
- `scripts/test-mv3-runtime.js`: 두 플랫폼의 생성 manifest, DOM 없는 번들 시작,
  동기 메시지 리스너 등록, 상태 조회 메시지 왕복, HTML 스크립트 존재 검사.
- 워커 환경의 네트워크 상태 회귀 테스트 추가. 기존 테스트 포함 268개 통과.

이 단계는 실사용 승인 단계가 아니다. 실제 브라우저의 중단/재개, 대량 복원,
양방향 동기화와 공격 입력에 대한 검증은 아직 완료되지 않았다.

## 다음 단계 / 실사용 전 통과 조건

3. 이벤트 리스너를 동기 등록하고 저장된 상태에서 재시작. 영속 큐와 복원 체크포인트,
   동기화 중단 후 재개 및 중복 업로드 방지 테스트.
4. HTTP 취소/타임아웃, 최소 범위 서버 권한, 다운로드 경로를 MV3에 맞게 구현.
5. AngularJS 취약점 경로 제거 및 의존성 재감사. 서버 메시지/북마크의 악성 입력 검증.
6. 테스트 전용 프로필/테스트 서버로 Chromium 및 Firefox 양방향 동기화,
   오프라인 재접속, 워커 강제 종료, 대량 북마크 복원, 백업 복구를 검증.

운영 서버·운영 북마크를 다음 단계의 테스트 데이터로 자동 사용하지 않는다.
현재 Firefox에 설치된 MV2 빌드와 프로필은 이번 MV3 조사에서 변경하지 않았다.

검증 명령 (개발 빌드는 `--mode=development` 추가):

```sh
npm ci --ignore-scripts
npm run webpack:chromium -- --env outputRoot=/tmp/xbs-mv3-build
npm run webpack:firefox -- --env outputRoot=/tmp/xbs-mv3-build
node scripts/test-mv3-runtime.js /tmp/xbs-mv3-build
npm test -- --runInBand
npm run lint
```

## 3단계 — 새 PC 실행부 (1.8.1 후보)

추가 조사에서 메모리 동기화 큐, 서버 PUT 이전의 성공 응답,
충돌 시 로컬 재동기화로 변경을 버리는 흐름, 복원 중단 체크포인트 부재를 확인했다.
AngularJS 워커 shim을 계속 늘리는 대신 `src/mv3`에 별도 PC 실행부와 화면을 구현했다.

- IndexedDB의 대상 데이터·원본 백업·생성 의도·진행 위치를 이용한 복원 재개.
- PUT 전 암호문 저장, 응답 유실 후 같은 암호문 존재 여부 확인.
- 양쪽 변경 시 충돌 상태로 중단하고 두 사본 보관.
- 서버 호스트별 선택적 권한, fetch 타임아웃·응답 크기 제한·리다이렉트 차단.
- 팝업/옵션 페이지에서 Blob 백업 다운로드; 워커에서 DOM API를 사용하지 않음.
- 북마크 텍스트는 textContent로 표시. URL을 자동 실행하지 않으며 검색에서
  클릭 가능한 링크는 HTTP(S)로 제한.
- 압축 해제도 블록 단위로 크기를 제한. 중복 ID·루트·깊이 검증 후 복원 시작.
- 기본 npm 설치/빌드에서 AngularJS 및 기존 UI 의존성을 제외.
  현재 npm audit은 0개이며, 이전 코드는 참고용으로만 남김.
- 기존 서버의 암호화·태그·설명과 버전을 유지. 신규 계정 생성/Android는 포함하지 않음.

실제 브라우저에서 팝업까지 확인했지만 서버 연결 이후 검증은 권한 승인으로
막혀 있다. **현재 후보를 ‘Firefox와 Chrome에서 모두 검증된 완성판’으로 판정하지 않는다.**
세부 증거와 미완료 항목은 [검증 기록](mv3-validation.md)에 기록했다.
현재 빌드 명령은 루트 README를 따른다. 위 2단계의 webpack/Jest 명령은 역사적 기록이다.

## 4단계 — 실제 Firefox·Chrome 통신 및 재시작 확인

Firefox 156의 Window 환경에서는 `fetch`를 API 인스턴스의 메서드로 호출하면
수신 객체가 Window가 아니어서 요청 전에 실패했다. 기본 fetch를 globalThis에
바인딩하도록 수정했다. 올바른 수신 객체를 확인하는 회귀 테스트를 추가했다.
이 문제는 Node 기반 모의 시험만으로는 드러나지 않았다.

수정 후 별도 프로필과 localhost의 가짜 계정으로 두 브라우저의 서버 복원,
북마크 왕복 수정, 메타데이터 보존과 백그라운드 재시작을 확인했다.
실제 대량 복원·백업 가져오기는 테스트 북마크 교체에 대한 추가 승인 대기 중이다.
현재 결과는 [검증 기록](mv3-validation.md)이 우선하며, 위 단계별 제약은 당시 기록이다.


## 5단계 — 실제 대량 복원과 백업 복구 검증 완료

2026-09-15 사용자 승인 후 Firefox Developer Edition 156.0b5와 Chrome
152.0.7977.83의 별도 테스트 프로필에서 각각 백업 다운로드·가져오기를 완료했다.
가짜 항목 76,010개를 복원하는 도중 백그라운드를 강제 종료했고,
재시작 후 진행 위치를 이어 최종 전체 해시 비교와 마지막 항목 검색을 통과했다.
추가 런타임 수정은 필요하지 않았다. Windows·macOS·Linux CI 역시 성공했다.
이 결과로 위 4단계의 추가 승인 대기 항목은 해소됐다.
Windows 브라우저 직접 실행, Mozilla 서명 및 운영 계정 전환은 별도 범위다.
