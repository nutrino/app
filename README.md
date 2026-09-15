# xBrowserSync MV3 desktop client

`mv3-codex` 브랜치의 Firefox·Chrome용 MV3 구현입니다. 기존 서버의
PBKDF2 / AES-GCM / LZUTF8 형식을 유지하며, AngularJS 없이 동작합니다.

**검증 상태:** macOS의 Firefox Developer Edition 156과 Chrome 152에서 팝업,
브라우저 간 양방향 동기화, 백업 다운로드·복구, 76,010개 실제 복원과 복원 도중
백그라운드 종료 후 재개를 확인했습니다. Windows·macOS·Linux CI도 통과했습니다.
Windows 브라우저의 직접 실행은 미검증이며, Firefox ZIP은 서명 전 빌드입니다.
자세한 범위는 [검증 기록](docs/mv3-validation.md)을 확인하세요.

## 빌드

Node.js 22 이상이 필요합니다. Windows, macOS, Linux에서 같은 명령을 사용합니다.

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm run build:firefox:dev
npm run build:chromium:dev
npm run package:firefox
npm run package:chromium
```

- Firefox: `build/mv3/firefox/manifest.json`을 `about:debugging`에서 임시 로드합니다.
- Chrome: `chrome://extensions`의 개발자 모드에서 `build/mv3/chromium` 폴더를 로드합니다.
- 배포 ZIP: `dist/xbrowsersync-mv3-{firefox,chromium}-1.8.1.zip`.
- 기존 `build/firefox` MV2 설치 파일은 덮어쓰지 않습니다.
- Firefox ID는 `mv3@nutrino.xbrowsersync`이며 기존 확장과 저장 공간이 분리됩니다.
  두 확장을 같은 북마크에 동시에 연결하지 마세요. 전환할 때 기존 동기화를 먼저 중지합니다.
- Firefox 임시 설치는 브라우저 종료 시 제거됩니다. 일반 Firefox의 영구 설치에는
  Mozilla 서명이 필요합니다. 이 저장소의 ZIP은 서명된 스토어 배포본이 아닙니다.

## 기존 서버에 연결

1. 팝업에서 서버 URL·기존 동기화 ID·비밀번호를 입력합니다.
2. 해당 서버 호스트에 대한 접근 권한을 허용합니다.
3. 복호화된 항목 수를 확인한 뒤 **로컬 백업 후 서버에서 복원**을 선택합니다.
4. 복원이 끝날 때까지 브라우저의 북마크를 편집하지 않습니다.

기존 xBrowserSync 1.5–1.8의 버전 정보가 있는 계정을 지원합니다. 신규 서버 계정
생성, 비밀번호 변경, Android UI는 이번 PC 클라이언트의 기능에 포함되지 않습니다.
태그·설명은 서버에 보존하며 브라우저에서 제목·주소·폴더·순서를 편집해 동기화합니다.

## 데이터 보존과 복구

- 양쪽에서 변경되면 자동 덮어쓰기를 중단하고 로컬/서버 사본을 따로 보존합니다.
- 서버 저장 응답이 유실되면 같은 암호문이 저장됐는지 먼저 확인합니다.
- 복원 전 백업, 이전 백업, 복원 진행 위치를 IndexedDB에 기록합니다.
- 백업 메뉴에서 JSON 다운로드와 복구를 할 수 있습니다. JSON에는 비밀번호·키가
  없지만 북마크는 평문입니다. 확장을 제거하면 내부 백업도 없어지므로 필요한 사본은 내려받으세요.
- 복구 후 동기화는 정지됩니다. 내용을 확인하고 재개하면 복구한 북마크를 업로드합니다.
- Chrome에 계정용/로컬용 루트가 중복되거나 지원하지 않는 루트에 데이터가 있으면
  임의로 합치거나 지우지 않고 오류를 표시합니다.
- 최대 250,000개 항목, 150단계 깊이, 64 MiB 응답/복호화 데이터 제한이 있습니다.

## 보안 및 개발 범위

비밀번호는 로컬에서 키를 유도하는 데만 사용합니다. 암호화 키는 자동 동기화를
위해 확장 내부 DB에 저장되므로 OS 계정에 접근할 수 있는 공격자로부터의 보호를
보장하지 않습니다. 지정한 서버 이외의 분석·광고·업데이트 서비스로 통신하지 않습니다.
HTTP 서버도 지원하지만 TLS가 없으므로 ID·수정 시각 노출과 응답 재생 위험이 남습니다.

현재 빌드 진입점은 `src/mv3`, 테스트는 `tests/mv3`입니다. `src/modules`, `webpack`,
`res/android`, `package.legacy.json`은 이전 구현 참고용이며 새 패키지에 포함되지 않습니다.
이전 Android/릴리스 자동화와 README는 `docs/legacy`에 보관했습니다.

[실패 원인 및 보안 조사](docs/mv3-assessment.md) · [검증 기록](docs/mv3-validation.md)

## Chrome 복원 마지막 단계에서 오류가 발생한 경우

Chrome은 `about:reader?...` 같은 주소를 `chrome://reader/?...`로 바꾸고,
제목의 일부 공백 문자를 정규화합니다. 이 변환을 데이터 손상으로 오인하던
비교 로직을 수정했습니다. 원본 URL·제목은 동기화 데이터에 보존합니다.
Firefox 읽기 모드 자체를 Chrome에 구현하는 변경은 아닙니다.

이전 빌드에서 항목 생성이 끝난 뒤 비교 오류로 정지했다면:

1. 최신 코드를 빌드하고 `chrome://extensions`에서 **기존 확장의 새로고침**을 누릅니다.
2. 확장의 **복원 차이 확인**으로 저장된 대상과 현재 북마크를 비교합니다.
3. 차이가 없으면 **동기화 재개**를 누릅니다. 저장된 마지막 단계에서 검사를 완료합니다.

확장을 삭제하면 복원 진행 기록과 내부 백업도 삭제됩니다. 위 절차는 기존 설치를
유지한 채 적용합니다. 차이가 남으면 필드·항목 ID가 표시되며 무조건 성공으로 넘기지 않습니다.

복원 시작 후 생성 진행률이 0에 머물던 Firefox 문제도 수정했습니다. 새 빌드는
기존 북마크 정리와 새 북마크 생성을 구분해 표시하고, 많은 형제 항목을 정리할 때
끝에서부터 묶음 처리합니다. 진행 중인 이전 빌드도 기존 확장의 새로고침으로
진행 기록과 백업을 유지한 채 업그레이드할 수 있습니다.
