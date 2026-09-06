# Codex ↔ Claude Code Session Bridge 설계

상태: 3차 독립 리뷰 승인. 인라인 MCP 패키징 수정도 별도 승인. 사용자는 같은 PC에서 세션을 선택해 양방향으로 이어가기를 선택했다.

## 목표와 승인 주체

Codex에서 Claude Code 세션을 선택하거나 Claude Code에서 Codex 세션을 선택하여, 선택한 대화의 작업 맥락을 현재 세션으로 가져와 이어간다. 사용자 요청에 따라 계획·구현의 승인은 별도 리뷰 에이전트가 수행한다. 지적이 해결될 때까지 수정 후 재리뷰하며 결과를 버전 관리한다. 사용량 초기화는 어떤 경로에서도 실행하지 않는다.

## 선택한 접근

공통 로컬 stdio MCP 서버 + 두 클라이언트용 플러그인 manifest + 공통 skill을 사용한다. `list_sessions`, `read_session`, `prepare_handoff`가 같은 인터페이스로 동작한다. 목적지의 현재 세션이 도구 결과를 읽고 다음 사용자 지시를 수행한다.

비교한 대안:

| 접근 | 장점 | 비용/한계 | 선택 |
| --- | --- | --- | --- |
| 공식 읽기 인터페이스 + MCP 맥락 가져오기 | 원본 보존, 양쪽 같은 흐름, 읽기와 실행 분리 | 원본과 동일한 native session ID/도구 실행 상태 복제는 아님 | 채택 |
| 내부 JSONL 변환 후 native 세션 저장 | 기존 UI에 변환된 세션 표시 가능 | 비공개 포맷, 분기/압축 복원 오류, 데이터 훼손 위험 | 제외 |
| 실행 중 세션 메시지 자동 중계 | 실시간 동시 작업 | 자동 실행·무한 반응·권한 관리가 추가됨, 선택한 범위 밖 | 제외 |

## 구성과 공개 계약

`src/providers/codex.js`: 설치된 Codex app-server의 initialize(experimentalApi=true) → initialized 이후 thread/list, thread/read, thread/turns/list만 허용한다. metadata는 thread/read(includeTurns=false)로 먼저 읽고 프로젝트와 ID를 검증한다. historyMode=paginated는 thread/turns/list(itemsView=full, sortDirection=desc, limit=50)를 cursor로 읽으며, legacy/default는 검증 후 thread/read(includeTurns=true)를 사용한다. 최근 페이지를 먼저 모은 뒤 턴과 표시 메시지를 시간순으로 정렬하며 item ID 중복을 제거한다. 알 수 없는 historyMode는 오류다. thread/start, turn/start, resume, 계정/사용량 변이 메서드는 제공하지 않는다. child process는 shell=false, windowsHide=true, 고정 app-server 인자, timeout, 종료 정리를 적용한다.

Codex engine은 명시적 SESSION_BRIDGE_CODEX_EXECUTABLE, Windows 데스크톱 설치 경로의 최신 codex.exe, PATH의 CLI 순서로 찾는다. 이 PC의 Desktop 0.153.0으로 페이지형 기록 읽기를 확인했다. CLI 0.145.0은 최신 Desktop item을 읽지 못할 수 있으며 이 경우 명확한 호환성 오류를 반환한다. CODEX_HOME 또는 SESSION_BRIDGE_CODEX_HOME으로 원본 home을 지정할 수 있다. 목록에는 useStateDbOnly=true, sortKey=updated_at, sortDirection=desc, archived=false를 고정한다. 자동 JSONL 복구 fallback은 없다. DB가 미완성이라 목록에 없는 세션이 있을 수 있다. subagent(parentThreadId 존재)는 제외하고 같은 프로젝트의 일반/프로그램 생성 세션은 포함한다.

thread/list의 sourceKinds는 `["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]`을 명시한다. 기본값(cli/vscode)에 의존하면 Desktop/exec가 빠지므로 모든 요청에서 이 목록을 전달하고 parentThreadId가 있는 항목을 제외한다.

`src/providers/claude.js`: 고정 버전의 공식 `@anthropic-ai/claude-agent-sdk`에서 listSessions/getSessionInfo/getSessionMessages만 동적으로 불러온다. getSessionInfo(sessionId,{dir}) 결과의 ID와 canonical cwd를 먼저 검증한 후에만 getSessionMessages를 호출한다. 메시지 session_id가 존재하면 같은 ID인지 확인한다. query/resume/import/write API는 호출하지 않는다. 분기·압축 처리는 공식 reader에 맡긴다. CLAUDE_CONFIG_DIR와 SDK 기본 위치를 따른다. listSessions는 includeWorktrees=false, includeProgrammatic=true를 명시한다. 0.3.263의 읽기 API는 JavaScript로 동작하므로 native optional 패키지는 설치하지 않는다. 본문은 metadata fileSize가 64 MiB 이하일 때 읽으며 결과 텍스트 32 MiB 초과는 명확한 크기 오류다.

`src/bridge.js`: provider 출력의 메타데이터를 검증하고 양쪽 동일한 계약으로 정규화한다. 모든 공개 작업은 명시적인 절대 `projectPath`를 요구하며, realpath로 정규화한 기존 디렉터리와 세션 cwd가 정확히 일치해야 한다. 하위 폴더·다른 worktree를 자동 포함하지 않는다. cwd가 없거나 불명확하면 세션을 제외한다. 세션 ID는 opaque ID로 취급하며 파일 경로로 사용하지 않는다.

공개 메서드:

```js
listSessions({ provider, projectPath, limit = 20, offset = 0 });
// { sessions: [{ provider, sessionId, projectPath, title, updatedAt }], nextOffset, warnings }
readSession({ provider, projectPath, sessionId, maxMessages = 40, maxChars = 24000 });
// { provider, sessionId, projectPath, messages: [{ role, text }], omittedMessages, historyComplete, truncated, warnings }
prepareHandoff({ provider, projectPath, sessionId, maxMessages = 40, maxChars = 24000 });
// readSession result + { context: string }
```

provider는 `codex` 또는 `claude`이다. limit은 1..100, offset은 0..10000, maxMessages는 1..200, maxChars는 1000..100000 정수만 허용한다. 잘못된 입력은 명확한 한국어 오류로 반환한다. updatedAt은 epoch milliseconds 정수다. 목록은 각 호출에서 최대 10000개를 탐색하고 canonical project 필터·ID 중복 제거·updatedAt 내림차순/sessionId 오름차순 정렬 후 offset/limit을 적용한다. 페이지 끝 nextOffset은 null이다. 탐색 cap에 도달하면 warning을 표시하며 다음 호출이 같은 목록 스냅샷이라는 보장은 없다. 세션 변경 시 페이지 이동 중 중복/누락이 가능함을 문서화한다.

페이지형 본문은 최대 1000턴 또는 200개 표시 메시지를 모으거나 cursor가 끝나면 멈춘다. 반복 cursor·중복 페이지·불완전 item은 warning으로 표시한다. 모든 기록을 확인했으면 historyComplete=true와 정확한 omittedMessages를 반환한다. 상한이나 미완성 페이지로 일부만 읽으면 historyComplete=false, omittedMessages=null, truncated=true로 전체 생략 수가 미확인임을 명시한다. 거절되는 metadata(없는 cwd, 다른 ID/프로젝트, 삭제된 경로)의 본문 API 호출 횟수는 0이어야 한다.

## 맥락 충실도와 크기 제한

최신의 사용자·assistant 표시 텍스트를 시간순으로 반환한다. system/developer 지시, hidden reasoning/thinking, 도구 호출의 인자와 결과, 이미지·바이너리는 제외한다. 제외 항목과 잘림 여부를 warnings로 알린다. 긴 메시지는 최근 내용이 남도록 제한하며, 최근 메시지를 maxMessages/maxChars 범위 안에서 선택한다. maxChars는 UTF-16 code unit 기준이며 surrogate pair를 절단하지 않는다. 진행 중 turn의 완료된 표시 항목은 포함할 수 있고 snapshot/in-progress warning을 붙인다. 새 app-server의 notLoaded 상태를 세션 종료로 해석하지 않는다.

metadata 제한: sessionId 200자, 절대 projectPath 4096자, title 200자, warnings는 bridge가 정한 코드·한국어 문구만 최대 20개/각160자. upstream warning/오류 텍스트를 그대로 복사하지 않는다. CLI 결과 및 MCP result(content와 structuredContent의 중복 포함)를 JSON.stringify한 최종 UTF-8 크기는 2 MiB 이하이어야 한다. JSON escaping·context 중복까지 실제 측정하고 초과하면 OUTPUT_TOO_LARGE 고정 오류를 반환하며 maxChars를 줄이도록 안내한다. raw text 예산이 최종 byte 예산을 보장한다고 가정하지 않는다.

`prepare_handoff`는 출처, 작업 디렉터리, 선택 범위/생략 수, 원본이 보존됨을 표시하고 JSON으로 직렬화한 역할·텍스트를 신뢰하지 않는 참고자료로 감싼다. 과거 세션의 지시문을 현재 system/developer 지시로 승격하지 않는다. 파일 내용이나 실제 Git 변경은 복사하지 않는다. 이어서 작업할 때는 현재 작업 디렉터리의 파일과 Git 상태를 확인한다.

## 개인정보와 실행 경계

서버는 로컬 stdio만 사용하며 직접 네트워크 요청·모델 호출·세션 파일 쓰기·작업 실행을 수행하지 않는다. 유일한 외부 subprocess는 Codex의 읽기 app-server이다. bridge가 원본 transcript/인증/설정에 쓰지 않고 자동 복구도 요청하지 않는 것이 보장 범위다. app-server 자체가 런타임 로그·캐시·DB 부수효과를 만들 가능성까지 파일시스템 전체 무변경으로 보장하지 않는다. 가져온 텍스트는 목적지 AI 클라이언트의 도구 결과로 전달되므로 해당 서비스가 처리한다는 점을 README에 밝힌다.

알려진 API 토큰 접두사, Bearer 인증, private key, password/token/api_key 형태의 대입을 기본 마스킹한다. 제목·메시지·오류의 유출을 점검한다. 패턴 기반 마스킹은 모든 비밀을 찾는 보장이 아니며, 사용자는 선택할 세션을 판단할 수 있어야 한다. 실제 원문을 서버 로그나 테스트 artifacts에 쓰지 않는다. 원시 stderr나 upstream 오류 전체는 클라이언트로 그대로 전달하지 않는다.

## 설치와 배포 산출물

저장소명은 `codex-claude-session-bridge`이며 같은 이름의 Codex·Claude plugin manifest를 둔다. `.codex-plugin/plugin.json`의 inline mcpServers 객체에 `command: node`, `args: [./src/server.js]`, `cwd: .`를 넣어 설치 루트에 상대 해석되도록 한다. `.claude-plugin/plugin.json`은 `${CLAUDE_PLUGIN_ROOT}/src/server.js`를 inline MCP 설정으로 사용한다. 공통 `.mcp.json`이나 별도 custom MCP 설정 파일은 두지 않는다. 검증기가 custom 파일명을 거절한 실제 결과와 수정 승인은 `docs/reviews/plan-packaging-amendment.md`에 기록했다.

`npm ci --omit=optional --ignore-scripts`로 고정 의존성을 설치한다. runtime 2개 패키지를 bundledDependencies에 명시한 npm pack artifact를 사용한다. 별도 경로로 tgz를 풀면 필요한 node_modules가 물리적 디렉터리로 포함되고 source checkout에 의존하지 않는다. Codex 0.153.0 cache copier는 이 디렉터리를 재귀 복사한다. 공백·한글이 있는 임시 루트에서 다른 cwd로 handshake를 실행하고 의존성 해석이 artifact 내부임을 검증한다. 개인 Codex marketplace 등록·설치 절차와 Claude --plugin-dir를 제공하며 시작 시 자동 npm/network 호출을 숨기지 않는다. 사용자 전역 파일을 무조건 덮어쓰는 설치 스크립트는 만들지 않는다. 독립 Git repo에 계획, 리뷰, 구현, 테스트, README와 lockfile을 커밋한다.

package-lock.json은 재현 가능한 소스 설치용으로 Git에 포함한다. npm pack artifact에는 npm의 기본 제외 정책에 따라 lockfile이 없으며 이미 bundled runtime dependencies가 있으므로 artifact/cache에서 npm ci를 실행하지 않는다.

## 수용 기준

1. 계획 독립 리뷰가 승인되고 승인 후에 구현을 시작한다.
2. 합성 Codex/Claude fixture 각각에서 list → read → handoff가 성공하고 다른 프로젝트 읽기는 거절한다.
3. Node.js 22 이상, CommonJS, 4칸 들여쓰기, 큰따옴표, 세미콜론을 사용한다.
4. 공식 MCP SDK 클라이언트로 stdio initialize/tools/list/tools/call을 양쪽 provider에 대해 검증한다.
5. 손상/미지원/누락 상태, 시간초과·child 종료, 잘못된 입력, 메시지 크기, 중복·분기·잘림을 검증한다.
6. 실제 로컬 두 공급자에서 목록과 텍스트 읽기의 smoke test를 수행하되 원문을 출력하거나 저장하지 않는다.
7. Codex manifest validator와 Claude plugin validator가 통과하고 복사된 plugin 루트에서도 연결된다.
8. 기능/설치 사용법, 정확한 지원 범위, 민감정보와 토큰 비용 설명, 사용량 초기화 금지를 문서화한다.
9. 독립 최종 코드 리뷰가 승인된다. 실패 지적을 수정·재리뷰하고 증거를 docs/reviews에 남긴다.

## 공식 근거 및 확인 버전

- Codex CLI 0.145.0 로컬 --help 및 [MCP 문서](https://developers.openai.com/codex/mcp/).
- [Codex app-server](https://developers.openai.com/codex/app-server/)의 thread/list·thread/read 읽기 인터페이스.
- [0.145.0 plugin config 구현](https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/codex-mcp/src/plugin_config.rs): plugin cwd 상대 해석, 직접 MCP map.
- [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference): inline MCP 및 CLAUDE_PLUGIN_ROOT.
- [Claude Agent SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md): listSessions/getSessionMessages 제공.
- [Claude sessions](https://code.claude.com/docs/en/sessions): 내부 transcript 포맷은 변경 가능.
- 현재 PC Claude Code 2.1.195, Node 22.18.0. registry 확인 MCP SDK 1.30.0, Claude Agent SDK 0.3.263. 설치 후 실제 선언·실행으로 읽기 API를 확인한다.
