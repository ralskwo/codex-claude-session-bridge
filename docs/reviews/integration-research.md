# Codex 로컬 통합 조사

조사일: 2026-09-06. 범위는 같은 PC의 세션 목록·메시지 읽기와 플러그인 패키징이다. 모델 실행, 세션 재개, 사용량 초기화는 호출하지 않았다. 실제 세션 검증은 원문을 출력하지 않고 개수·필드·오류 형태만 기록했다. Claude SDK 조사는 별도 조사 결과와 합쳐야 한다.

## 권장 결정

- Codex 어댑터는 공식 App Server를 사용한다. `thread/read(includeTurns: true)`만으로 구현하면 현재 데스크톱 세션을 읽지 못한다. `historyMode: "paginated"`를 지원해야 한다.
- 현재 PC에서 npm CLI는 **0.145.0**, 실행 중인 데스크톱 엔진은 **0.153.0**이다. 원본 세션을 만든 앱과 호환되는 엔진을 우선한다.
- `thread/list`는 `useStateDbOnly: true`를 필수로 보낸다. 공식 문서에 따르면 기본값은 JSONL을 스캔하여 메타데이터를 복구할 수 있다. 읽기 전용 목록 조회에는 이 기본 동작을 사용하지 않는다.
- 현재 목적은 가져온 맥락으로 대상 세션에서 이어가기이다. 원본 세션을 재개하거나 transcript에 내용을 직접 쓰는 기능은 필요하지 않다.
- 공통 메시지 출력은 `userMessage`, `agentMessage`만 먼저 지원한다. 도구 출력·reasoning·암호화된 내부 콘텐츠는 기본 전달 대상에서 제외한다.

공식 API 의미와 페이지 처리 설명: [Codex App Server](https://learn.chatgpt.com/docs/app-server).

## 실제 검증 결과

| 실행 환경 | 요청 | 결과 |
| --- | --- | --- |
| npm 0.145.0, 샌드박스 기본 홈 | initialize → thread/list | 초기화 성공, 결과 0개. `codexHome`이 실제 사용자와 다른 `C:\Users\CodexSandboxOffline\.codex`였다. |
| npm 0.145.0, 실제 CODEX_HOME, 샌드박스 | initialize | 20초 제한 내 초기화하지 못함. |
| npm 0.145.0, 실제 사용자 권한 | initialize → thread/list(useStateDbOnly:true) | 성공. 결과 1개와 메타데이터 필드 확인. |
| npm 0.145.0 | thread/read(includeTurns:true) | `-32600: paginated threads do not support thread/read(includeTurns=true)` |
| npm 0.145.0, experimentalApi:true | thread/turns/list(itemsView:full) | `-32603`: 저장된 SubAgentActivity의 `completed` 변형을 역직렬화하지 못함. 지원 목록은 started/interacted/interrupted였다. |
| 데스크톱 0.153.0, 실제 사용자 권한 | thread/read(includeTurns:false) | 성공. historyMode=paginated, turns=[], status=notLoaded. |
| 데스크톱 0.153.0, experimentalApi:true | thread/turns/list(itemsView:full) | 성공. 현재 턴 1개 및 메시지 필드 확인, stderr 출력 없음. |

테스트는 숨겨진 자식 프로세스에서 수행했다. 요청 종류는 initialize, initialized, thread/list, thread/read, thread/turns/list로 한정했다. 대화 원문·인증 정보는 출력하지 않았고 전역 설정이나 원본 대화를 직접 수정하지 않았다.

별도 App Server가 반환한 `thread.status: notLoaded`는 실행 중인 원래 데스크톱 작업의 유휴 상태를 뜻하지 않는다. 런타임 상태는 해당 서버 기준이므로 선택 화면에는 최신 턴 상태와 스냅샷이라는 점을 함께 사용한다.

## 실행 파일과 홈 탐색

현재 확인한 실행 파일:

- npm: `C:\Users\ralskwo\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe` (0.145.0)
- 데스크톱: `C:\Users\ralskwo\AppData\Local\OpenAI\Codex\bin\9ba750cce02d5e5c\codex.exe` (0.153.0)
- 실제 Codex 홈: `C:\Users\ralskwo\.codex`

구현 시 버전 해시 디렉터리를 고정하지 않는다. 명시적 설정의 실행 파일을 우선하고, Windows에서는 실제 사용자 프로필의 `AppData/Local/OpenAI/Codex/bin/*/codex.exe`를 Node `fs.readdir`/`fs.stat`으로 후보 수집할 수 있다. 각 후보에 `--version`을 실행하여 버전을 확인하고 호환되는 데스크톱 엔진을 선택한다. 실행 중인 프로세스의 경로 조회는 이번 조사에서 사용한 보조 방법이며 구현의 필수 의존성이 아니다. npm CLI는 호환성 검증 후 대체 경로로 쓴다. 다른 OS는 명시적 실행 파일 또는 PATH 실행 파일을 지원한다.

Windows에서는 `.ps1`이나 `.cmd` 런처를 문자열 셸 명령으로 합성하지 말고 검증한 네이티브 실행 파일을 직접 `spawn`한다. `windowsHide: true`, `shell: false`, `stdio: ["pipe", "pipe", "pipe"]`를 사용한다. 실제 홈을 알고 있는 설치 단계에서 경로를 명시적으로 저장하거나 사용자 지정으로 받는다. 샌드박스의 `os.homedir()`를 실제 사용자 홈이라고 가정하지 않는다. 초기화 응답의 `codexHome`이 선택한 경로와 일치하는지도 검사한다.

## 정확한 프로토콜 흐름

`<engine> app-server --stdio`로 실행하고 UTF-8 JSON 한 줄씩 stdin/stdout으로 송수신한다. 아래는 실제 0.153.0에서 성공한 요청 형태이다.

```json
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"session_bridge","version":"0.1.0"},"capabilities":{"experimentalApi":true}}}
```

초기화 응답을 받은 다음 알림을 보낸다.

```json
{"method":"initialized","params":{}}
```

목록 조회:

```json
{"id":2,"method":"thread/list","params":{"limit":25,"sortKey":"updated_at","useStateDbOnly":true,"sourceKinds":["cli","vscode","exec","appServer","subAgent","subAgentReview","subAgentCompact","subAgentThreadSpawn","subAgentOther","unknown"]}}
```

`result`는 `{data, nextCursor, backwardsCursor}`이다. 다음 페이지는 `cursor: nextCursor`를 보낸다. 기본 sourceKinds는 대화형 CLI/IDE만 포함하므로 앱 세션을 명시적으로 포함한다. 기본 선택 목록에서 `parentThreadId`가 있는 내부 서브에이전트는 제외하고, 필요할 때 확장 표시한다. `cwd`는 정확한 경로 필터이며 사용자 검색 조건이 있을 때만 사용한다.

세션 메타데이터:

```json
{"id":3,"method":"thread/read","params":{"threadId":"<selected-id>","includeTurns":false}}
```

`result.thread.historyMode`가 `paginated`이면 아래 요청으로 메시지를 읽는다.

```json
{"id":4,"method":"thread/turns/list","params":{"threadId":"<selected-id>","limit":20,"sortDirection":"desc","itemsView":"full"}}
```

응답은 `{data: Turn[], nextCursor, backwardsCursor}`이다. 예산에 필요한 최신 페이지부터 읽고 선택한 턴·메시지를 시간순으로 정렬한다. 일반 rollout 세션은 `thread/read`에 `includeTurns:true`를 사용하거나 지원되는 경우 같은 턴 페이지 API를 쓸 수 있다. 저장 방식 오류를 세션 없음으로 취급하지 않는다. 페이지 API가 지원되지 않거나 저장 항목을 해석할 수 없으면 버전 호환 오류를 반환한다.

요청 ID별 pending map, 줄 단위 수신 버퍼, 제한 시간, 최대 응답 크기, 자식 프로세스 종료 처리를 둔다. `thread/resume`, `thread/start`, `turn/start`는 어댑터에서 노출하지 않는다.

## 응답 필드와 공통 변환

0.153.0에서 관찰한 주요 필드:

```text
Thread:
  id, sessionId, parentThreadId, forkedFromId, historyMode,
  cwd, path, cliVersion, source, threadSource, name, preview,
  createdAt, updatedAt, recencyAt, status, turns,
  modelProvider, model, reasoningEffort, projectId, section

Turn:
  id, items, itemsView, status, error,
  startedAt, completedAt, durationMs

userMessage:
  type, id, clientId, content: [{type:"text", text, text_elements}]

agentMessage:
  type, id, text, phase, memoryCitation, delivery, questions
```

공통 이벤트 예시이며 실제 대화 내용이 아니다:

```json
{
  "schemaVersion": 1,
  "source": "codex",
  "sessionId": "example-session",
  "turnId": "example-turn",
  "eventId": "codex:example-session:example-turn:example-item",
  "role": "assistant",
  "phase": "final_answer",
  "text": "합성 예시: 설정 로딩 문제를 수정하고 검증했다.",
  "timestamp": "2026-09-06T12:00:00.000Z",
  "turnStatus": "completed",
  "truncated": false
}
```

이벤트 ID는 원본 ID 조합으로 안정적으로 만든다. timestamp는 턴 시작·완료 시각 등 출처를 명시할 수 있는 값으로 구성하고 없는 시각을 만들어 내지 않는다. 가져온 내용은 참고 대화 데이터로 표시하며 대상 세션의 시스템·개발자 지침으로 승격하지 않는다. 크기 제한과 truncation 메타데이터를 유지하고 이미지·파일은 기본적으로 바이너리 없이 존재 여부를 표시한다.

## JSONL 조사와 제한

최근 파일 3개에서 최상위 `{timestamp, ordinal, type, payload}`를 관찰했다. `event_msg/item_completed`의 item에는 `UserMessage`, `AgentMessage`, `Reasoning`, `CommandExecution` 등 PascalCase 변형이 있다. `response_item`에는 개발자 메시지, 함수 호출, 내부 agent_message, encrypted_content 등이 함께 있다. 같은 사용자 메시지를 여러 표현에서 중복 추출할 위험이 있다.

따라서 JSONL을 정상 동작의 주 어댑터로 사용하지 않는다. 향후 별도 fallback을 만든다면 읽기 전용, 버전별 합성 fixture, 완성된 한 줄만 파싱, 항목 ID 중복 제거, 내부 콘텐츠 제외를 전제로 한다. 폴더명이나 파일명만으로 현재 데스크톱 저장 방식을 완전히 설명할 수 없다.

## 플러그인 MCP 경로와 로컬 설치

Codex native 플러그인의 `${CODEX_PLUGIN_ROOT}` 치환은 확인되지 않았다. 실제 0.145.0 파서와 현재 소스는 상대 `cwd`를 플러그인 루트에 결합한다. 따라서 환경변수 치환 없이 다음 구성을 사용한다.

`.codex-plugin/plugin.json`:

```json
{"name":"codex-claude-session-bridge","version":"0.1.0","mcpServers":"./.mcp.json","skills":"./skills/"}
```

위 manifest는 경로 설명용 최소 예시이다. 실제 배포본은 plugin-creator validator가 요구하는 설명·작성자·interface 필드를 포함한다.

`.mcp.json`:

```json
{
  "session-bridge": {
    "command": "node",
    "args": ["./src/server.js"],
    "cwd": "."
  }
}
```

주의: 공식 패키징 문서의 wrapped 예시는 `mcp_servers`지만 0.145.0 소스는 camelCase `mcpServers`로 역직렬화한다. 직접 서버 맵을 사용하면 이 차이를 피할 수 있다. Claude용 manifest/경로 설정은 Claude의 규약에 맞춰 별도로 작성한다.

근거: [0.145.0 MCP 파서](https://raw.githubusercontent.com/openai/codex/rust-v0.145.0/codex-rs/codex-mcp/src/plugin_config.rs), [공식 플러그인 패키징](https://developers.openai.com/plugins/build/plugins), [MCP 설정](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

개인 marketplace 기본 위치는 `~/.agents/plugins/marketplace.json`이다. plugin-creator 지침의 기본 `source.path: "./plugins/<name>"`는 `.agents/plugins` 폴더가 아닌 사용자 홈 기준으로 해석된다. 설치는 `codex plugin add <name>@<marketplace>`이며 설치본은 캐시에 복사된다. 개발 중 수정은 버전 cachebuster 갱신 후 재설치하고 새 작업에서 도구를 확인한다. 등록·재설치 자체는 이번 조사에서 수행하지 않았다.

## node_modules 복사와 배포 아티팩트

**0.153.0의 local plugin install 경로는 node_modules를 제외하지 않는다.** `PluginStore`는 소스 디렉터리를 재귀 복사하며 파일명 제외 목록이나 gitignore 필터를 사용하지 않는다. 일반 디렉터리·파일만 복사하므로 symlink에 의존하는 설치 레이아웃은 적합하지 않다. 근거: [0.153.0 PluginStore의 copy_dir_recursive](https://raw.githubusercontent.com/openai/codex/rust-v0.153.0/codex-rs/core-plugins/src/store.rs).

`npm pack`과 bundledDependencies로 만든 패키지를 풀어 실제 node_modules 파일이 들어 있는 독립 디렉터리를 local marketplace에 등록하는 방식은 이 복사 규칙과 맞는다. 다만 npm 패키지 내용과 `--omit=optional`의 SDK 호환성은 별도 검증이 필요하다. 권장 배포 확인:

1. 패키지 파일 목록에 `.codex-plugin/plugin.json`, `.mcp.json`, Claude manifest, skills, 서버 코드, 실제 production 의존성이 있는지 검사한다.
2. 원본 저장소 밖 임시 경로에 패키지를 풀고, 그 디렉터리에서 MCP initialize/tools/list 및 합성 fixture 호출을 수행한다.
3. Codex 설치 후 반환된 cache 경로에서 같은 smoke test를 실행하여 소스 저장소나 상위 node_modules에 의존하지 않는지 확인한다.
4. 패키지 내부 symlink·불필요한 SDK 바이너리·인증 파일·세션 데이터가 없는지 확인한다. 선택적 의존성 생략은 실제 readonly SDK 호출을 검증한 뒤 확정한다.

이 조사는 패키징 소스 근거와 API 읽기 검증을 제공한다. 실제 설치본 MCP 동작 및 Claude SDK smoke test의 완료를 대신하지 않는다.
