# 독립 계획 리뷰 — 1차

- 판정: **CHANGES_REQUESTED**
- 검토일: 2026-09-06
- 검토자: 독립 `plan_review` 에이전트
- 기준 커밋: `3fdf592b6b9e32cf633bbf74a608bf10523c0ee4`
- 범위: `AGENTS.md`, 설계 문서, 구현 계획. 구현 코드는 아직 없음.
- 사용량 초기화 또는 모델 실행을 호출하지 않았다. SDK 공개 코드와 선언을 읽었으며 개인 세션 원문을 읽거나 저장하지 않았다.

공통 stdio MCP로 선택한 세션의 표시 텍스트를 현재 클라이언트에 전달하는 접근은 요구사항에 적합하다. native 세션 복제와 자동 실행을 제외하고 프로젝트를 명시하도록 한 점도 타당하다. 그러나 현재 Desktop 기록에서 실패하는 읽기 경로와 읽기 경계의 누락 때문에 구현 시작은 승인하지 않는다.

## R1 — Important: 현재 Desktop의 페이지형 기록을 읽을 수 없음

위치: 설계 23행, 계획 Task 1의 80–81행 및 provider allowlist.

현재 설계는 `thread/read(includeTurns:true)`만 본문 읽기에 허용한다. 부모 작업에서 전달받은 설치 버전 0.145.0 실측에서는 `historyMode:"paginated"` 세션에 대해 이 요청이 거절된다. 독립적으로 확인한 [공식 app-server 문서](https://developers.openai.com/codex/app-server/)도 `thread/turns/list`와 `itemsView:"full"`을 통한 기록 조회를 제공한다. 따라서 현 계획대로 구현하면 핵심 대상인 현재 Desktop 세션의 양방향 이어가기 중 Codex → Claude가 실패한다.

수정 요구:

- `thread/read(includeTurns:false)`로 metadata/historyMode를 먼저 조회한다.
- 페이지형 기록에는 `thread/turns/list`를 allowlist에 추가하고 `itemsView:"full"`, 페이지 순서, cursor, 종료 조건을 명시한다. 설치 버전에서 필요한 experimental capability도 확인한다.
- 기존 기록에는 검증 후 `thread/read(includeTurns:true)`를 사용한다. 미지원 history mode는 안전한 오류로 끝낸다.
- 최신 내용 보존, 페이지 중복, 반복 cursor, 누락 item, 탐색 상한 도달 시 완전성 표시를 계약에 추가한다. 일부 페이지만 읽으면 전체 생략 메시지 수를 정확히 알 수 없으므로 `omittedMessages`의 알려진 수/미확인 상태를 명시한다.

수용 증거: legacy와 paginated 합성 응답에서 동일한 최신 표시 텍스트를 반환하며, paginated 경로가 금지된 full-history read를 호출하지 않는 테스트. 실제 설치 버전에서 page형 기록을 본문 없이 개수로 검증한다.

## R2 — Important: 목록 API의 기본 동작이 원본 보존 설명과 충돌

위치: 설계 23행과 48–50행, 계획 Task 1의 80–81행.

[공식 app-server 문서](https://developers.openai.com/codex/app-server/)에 따르면 `thread/list`는 기본적으로 JSONL을 스캔하여 메타데이터를 복구한다. `useStateDbOnly:true`를 전달해야 이 동작을 제외한다. 현재 계획은 cwd와 pagination만 지정하므로 읽기 메서드만 호출한다는 사실만으로 원본 상태 보존을 보장할 수 없다.

수정 요구:

- 모든 `thread/list`에 `useStateDbOnly:true`를 고정한다. DB가 누락되거나 오래되어 발견하지 못하는 세션이 있을 수 있다는 지원 한계를 기록하고 자동 복구 fallback을 금지한다.
- bridge 자체의 세션/인증/설정 쓰기 금지와 app-server가 생성할 수 있는 런타임 로그·캐시·DB 부수효과를 구분한다. 보장하지 못하는 완전한 파일시스템 무변경 표현을 사용하지 않는다.
- 실제 source home 지정은 명시적인 환경 설정으로 지원하고, 잘못된 sandbox home에서 발견한 빈 목록을 사용자 history가 없는 것으로 단정하지 않는다.

수용 증거: fake RPC가 모든 목록 요청의 `useStateDbOnly`를 assert하고, 허용 메서드 밖의 변이 요청이 전혀 없는 테스트. 합성 home에서 전후 파일 점검으로 source transcript/인증/설정 보존을 확인한다.

## R3 — Important: 프로젝트 검사보다 먼저 다른 세션 본문을 읽을 수 있음

위치: 설계 25–27행, 계획 provider `read` 계약(61–62행), Task 1의 78행, Task 2의 121행.

계획은 `read` 결과의 projectPath를 다시 검사하지만 본문 API 호출 전 검사 순서가 고정되어 있지 않다. `getSessionMessages` 결과에는 cwd가 없고, `dir`은 SDK의 파일 탐색 범위이지 bridge의 realpath 동일성 검증을 대체하지 않는다. 잘못된 세션 ID/메타데이터를 가진 요청을 읽은 뒤 거부하는 구현도 현 테스트를 통과한다.

공개 설치 패키지 `@anthropic-ai/claude-agent-sdk@0.3.263`의 `sdk.d.ts`에서 `getSessionInfo`(767행), cwd를 포함하는 `SDKSessionInfo`(5059행)를 확인했다. `getSessionMessages`는 797행에 있고 메시지 타입에는 cwd가 없다. `sdk.mjs`의 공개 export wrapper도 metadata reader와 message reader를 각각 제공한다.

수정 요구:

- Claude 허용 API에 `getSessionInfo`를 추가한다. 명시한 dir로 metadata를 조회하고 sessionId 및 canonical cwd를 검증한 뒤에만 `getSessionMessages`를 호출한다.
- Codex도 R1의 metadata read 후 동일하게 검증하고 본문을 요청한다. provider가 이 순서를 보장하며 bridge의 결과 재검증은 추가 방어로 남긴다.
- 알 수 없는 cwd, 불일치 ID, 다른 프로젝트, 삭제된 directory에서 본문 reader 호출 횟수가 **0**임을 spy 테스트로 검증한다.
- 정상 메시지의 `session_id` 등 식별자가 존재하면 요청한 세션과 일치하는지도 확인한다. 반환된 upstream 문자열/객체를 그대로 노출하지 않는다.

수용 증거: 위 거절 경로에서 본문 API 미호출 검증과 정상 요청의 metadata → body 순서 테스트.

## R4 — Important: 최종 출력의 크기 계약이 아직 성립하지 않음

위치: 설계 40–44행, 계획 Task 2의 `boundMessages` 및 Task 3 structuredContent/JSON text 출력.

maxChars는 원문 UTF-16 문자 수이다. JSON 직렬화는 제어문자 하나를 최대 6개 ASCII 문자로 만들고, handoff는 messages를 context에 다시 포함하며 MCP도 structuredContent와 JSON text를 함께 전달한다. 이 비용은 고정 wrapper 오버헤드가 아니다. title/warnings/projectPath의 길이와 warning 개수도 제한이 없으므로 현재 문장만으로는 최종 출력 상한을 검증할 수 없다.

수정 요구:

- 원문 선택 예산과 최종 직렬화된 MCP/CLI 결과 바이트 예산을 구분하고 구체적인 상한 또는 최악의 경우 공식으로 정의한다.
- title, path, warnings, ID 등 메타데이터의 최대 길이/개수와 허용 타입을 정한다. upstream 원문 warnings 대신 고정 코드/제한된 메시지를 사용한다.
- `prepare_handoff`의 중복 메시지와 MCP의 중복 표현을 포함해 최종 payload를 측정한다. 초과 시 유효한 JSON과 warning을 유지하며 더 줄이거나 명확한 오류를 반환한다.

수용 증거: 많은 제어문자·역슬래시·따옴표·emoji, 긴 제목과 경로, 다수의 제외 항목을 사용하여 최종 출력 크기를 검증한다. 잘림 뒤에도 자격증명 마스킹과 surrogate pair가 보존되어야 한다.

## R5 — Minor: 목록의 최신순·페이지 계약을 provider 옵션까지 고정

위치: 설계 40행, 계획 Task 1의 목록 처리.

Codex 목록 기본 정렬은 생성 시각이지만 공개 결과는 갱신 최신순이다. `sortKey:"updated_at"`/`sortDirection:"desc"`를 명시하고, timestamp 단위를 정규화해야 한다(Claude `lastModified`는 밀리초). exact SDK에는 `listSessions`의 offset도 이미 있다. 프로젝트 검증/중복 제거 후 적용하는 offset인지, upstream offset인지 명확히 하며 정렬 동률이 페이지 경계에 있을 때의 일관성을 테스트한다. archived 및 프로그램 생성 세션 포함 범위도 README에 고정한다.

## R6 — Minor: 설치 검증은 실제 배포 파일만으로 실행해야 함

위치: 설계 설치/배포, 계획 Task 3의 144행 및 Task 4.

복사 루트 handshake 기준은 적절하지만 원본 checkout의 node_modules까지 복사하거나 상위 디렉터리 의존성에서 우연히 해결되면 배포 가능성을 증명하지 못한다. 구현 시 선택한 한 가지 Codex 캐시 의존성 설치 전략을 README와 검증 스크립트에 구체화한다. 공백·한글이 있는 별도 경로와 다른 cwd에서 실행하며 소스 checkout/node_modules에 의존하지 않는지 확인한다.

현재 [Claude plugin 문서](https://code.claude.com/docs/en/plugins-reference)는 lockfile이 있는 cache plugin에 `npm ci --ignore-scripts`를 실행한다고 설명한다. 그러나 이 사실을 설치된 Claude 2.1.195에도 검증 없이 적용하면 안 된다. `--plugin-dir`와 명시적인 npm ci fallback은 별도로 검증한다. 자동 npm 설치·네트워크 호출을 MCP 시작에 숨겨 넣지 않는다.

## 재리뷰 승인 조건

R1–R4의 API·경계·출력 계약을 설계와 계획 양쪽에 반영하고 해당 수용 테스트를 계획에 추가해야 한다. R5–R6의 검증 기준도 구체화한다. 이는 구현 전 계획 승인 조건이며 구현 결과를 미리 승인하는 것이 아니다. 이후 독립 코드 리뷰에서는 실제 테스트 결과와 설치 증거를 다시 평가한다.
