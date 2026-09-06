# Task 2 / Task 3 인터페이스 독립 리뷰 1차

- 검토일: 2026-09-06
- 기준: `a1505e3`의 Task 2 공통 계층과 `8e29ee7`에서 포함된 MCP/CLI 구현. 관련 brief, Task 2 report, `interface-review.diff`, 실제 소스와 테스트를 대조했다.
- 범위: `src/bridge.js`, `src/content.js`, `src/project.js`, `src/server.js`, `src/cli.js`와 관련 테스트. 병행 수정 중인 provider와 최종 패키징은 이번 판정에서 제외했다.
- 원본 세션/인증/전역 설정에 접근하지 않았으며 모델 호출·사용량 초기화는 수행하지 않았다.

## 판정

| 범위 | 사양 준수 | 코드 품질 |
| --- | --- | --- |
| Task 2 프로젝트 경계·bounded context | 승인 | 승인 |
| Task 3 MCP·CLI 인터페이스 | 수정 후 재리뷰 | 수정 후 재리뷰 |

Task 2에서는 차단할 결함을 찾지 못했다. 실제 경로 정규화, 읽기 응답 프로젝트/ID 재검증, 허용 인자와 정수 예산 검증, 최신 텍스트 선택, UTF-16 surrogate 보존, 마스킹 후 절단, 미확인 생략 수, 고정 경고/오류, 최종 JSON UTF-8 크기 제한을 확인했다. 제목도 마스킹 후 길이가 제한된다. 마스킹은 설계에 명시된 패턴 기반 범위이며 모든 비밀 탐지를 보장하는 것으로 판정하지 않았다.

Task 3의 stdio 구성, 세 도구 매핑과 읽기 전용 annotations, JSON text/structuredContent 동시 제공, 전체 MCP result의 크기 제한, CLI stdout/stderr 분리는 적절하다. 아래 두 문제를 수정해야 한다. manifest·skill·bundle에 대한 Task 3 전체 승인은 별도 패키징 리뷰가 필요하다.

## 수정 필요 사항

### R1 — P2: MCP 서버에서 선언한 입력 스키마를 실제 요청에 검증하지 않음

- 위치: `src/server.js:40`–`47`, 스키마 선언 `src/server.js:9` 및 `13`.
- Task 3 brief는 입력 제약을 schema와 bridge 양쪽에서 적용하고 schema rejection을 검증하도록 요구한다. 현재 저수준 SDK `Server`의 CallTool handler는 도구의 `inputSchema`를 검증하지 않고 바로 bridge를 호출한다. `CallToolRequestSchema`는 MCP 요청 외피만 검사한다.
- 합성 bridge를 주입하고 공식 SDK `Client`/`InMemoryTransport`로 `read_session`에 `{ provider: "invalid", projectPath: ".", sessionId: "../invalid", maxChars: 1, extra: true }`를 호출했다. 결과는 `bridgeCalls: 1`, `isError: false`였다. 기존 stdio 테스트가 같은 입력에 오류를 반환하는 것은 실제 bridge의 검증 결과여서 MCP 자체의 schema rejection 증거가 아니다.
- 공개 스키마에도 sessionId의 control/path separator 금지 조건이 없다. projectPath는 절대 경로라는 설명만 있고 문자열 형태 제약이 없다. 따라서 현재 광고한 스키마와 bridge 계약도 완전히 일치하지 않는다.
- 수정: dispatch 전에 선언된 도구 스키마에 맞춰 검증하고 고정 `INVALID_ARGUMENT` 오류를 반환한다. 사양의 문자열 형태 제약도 스키마에 반영하고, 기존 canonicalProject의 디렉터리 검증은 유지한다. 잘못된 입력에서 합성 bridge 호출이 0회임을 확인하는 테스트를 추가한다.
- 영향 제한: 현재 production bridge는 잘못된 입력을 거절하므로 provider 실행 경계가 바로 우회되는 취약점은 아니다. 다만 명시된 이중 검증 계약과 해당 테스트가 충족되지 않는다.

### R2 — P2: 잘못된 CLI 옵션을 공급자 읽기 실패로 보고함

- 위치: `src/cli.js:14`, `21`, `25`, `55`와 오류 변환 `66`.
- parser는 `new Error("INVALID_FLAG")` 또는 `new Error("INVALID_COMMAND")`를 던진다. `safeError`는 `.code`를 사용하므로 이 오류들을 모두 `PROVIDER_ERROR`로 변환한다.
- 합성 검증에서 `runCli(["list", "--limit", "2.2"], ...)`는 exitCode 1과 `{ "code": "PROVIDER_ERROR", "message": "세션 공급자의 읽기 작업에 실패했습니다." }`를 반환했다. 실제 공급자 호출이 없는데 공급자 문제로 안내하므로 사용자가 입력을 고칠 근거를 얻지 못한다. 알 수 없는 명령, 누락/중복 옵션, doctor의 불필요한 인자도 같다.
- 수정: 파싱 오류에 `bridgeError("INVALID_ARGUMENT")` 등 고정된 인자 오류 코드를 사용한다. 관련 테스트에서 단순히 stderr가 있는지뿐 아니라 입력 오류 코드와 한국어 메시지의 의미를 검증한다. doctor의 runtime 검사 실패 역시 현재 일반 Error이므로 지원 환경 문제를 구분할 수 있는 고정 코드로 정리하는 것이 좋다.

## 검증 증거

- 보고된 기존 결과: Task 2 25/25, MCP/CLI 7/7 통과. 이미 입증된 전체 테스트는 반복하지 않았다.
- 실제 코드와 기존 테스트를 읽고 위 두 의심 지점에 한해 합성 probe를 실행했다.
- MCP probe: 공식 SDK Client/InMemoryTransport, 잘못된 도구 인자가 합성 bridge까지 전달되어 성공 결과를 반환함을 재현했다.
- CLI probe: 잘못된 숫자 옵션이 공급자 오류로 잘못 보고됨을 재현했다.
- 프로덕션 파일은 수정하지 않았다. 이번 리뷰 기록만 추가했다.
