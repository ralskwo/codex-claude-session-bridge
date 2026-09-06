# Session Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 같은 PC의 Codex와 Claude Code 세션을 선택해 현재 상대 클라이언트에서 작업 맥락을 이어간다.

**Architecture:** 공식 Codex app-server와 Claude Agent SDK의 읽기 API를 provider로 감싸고, 공통 정규화/제한/마스킹 계층을 stdio MCP 및 CLI로 제공한다. 두 플러그인은 동일 코드를 사용하며 원본 세션을 변경하지 않는다.

**Tech Stack:** Node.js >=22, CommonJS, @modelcontextprotocol/sdk 1.30.0, @anthropic-ai/claude-agent-sdk 0.3.263, node:test.

**Spec:** `docs/superpowers/specs/2026-09-06-session-bridge-design.md`

## Global Constraints

- Node.js 22 이상, CommonJS, 4칸 들여쓰기, 큰따옴표, 세미콜론을 사용한다.
- 모든 공개 작업은 명시적인 절대 `projectPath`를 요구한다.
- 원본 세션·인증·전역 설정을 테스트에서 변경하지 않는다.
- 사용량 초기화는 어떤 경로에서도 실행하지 않는다.
- 자동 모델 호출·자동 대화 중계·native transcript 변환/쓰기는 범위 밖이다.
- 실데이터 검증은 본문을 출력하지 않고 성공 여부와 집계만 기록한다.
- 독립 계획 리뷰 승인 후 구현하며 독립 최종 코드 리뷰 승인 전 완료로 표시하지 않는다.

## Repository map and execution order

```text
.codex-plugin/plugin.json       Codex manifest
.claude-plugin/plugin.json      Claude manifest (inline MCP)
.codex-mcp.json                 Codex-specific cwd 설정
package.json / package-lock.json
src/providers/codex.js          app-server 읽기 adapter
src/providers/claude.js         공식 SDK 읽기 adapter
src/providers/rpc.js            bounded app-server subprocess 통신
src/bridge.js                  검증·프로젝트 scope·공통 결과
src/content.js                 텍스트 정규화·마스킹·제한·handoff
src/server.js                  MCP stdio entry
src/cli.js                     list/read/handoff/doctor CLI
skills/session-bridge/SKILL.md  양방향 선택·이어가기 절차
test/*.test.js                 실제 동작/프로토콜 tests
test/fixtures/                 합성 provider 응답·가짜 RPC child
scripts/smoke-local.js         원문 없는 실세션 검증
README.md                     설치·사용·한계
docs/reviews/                  계획/코드 리뷰와 수정·승인 기록
```

독립 repo에서 `feat/session-bridge` branch를 사용한다. Task 1 provider 구현과 Task 2 공통 계층은 아래 계약이 고정된 후 파일 소유권을 분리해 병렬 진행 가능하다. Task 3은 둘 다 통과한 다음 결합한다. Task 4는 설치 검증과 전체 리뷰다.

### Task 1: 공식 읽기 provider와 subprocess 수명 관리

**Files:** `src/providers/{codex,claude,rpc}.js`, `test/providers.test.js`, `test/fixtures/rpc-child.js`, `package.json`, `package-lock.json`.

**Interfaces:**

```js
createCodexProvider(options = {});
// options: executable?, codexHome?, timeoutMs? (default 15000), maxResponseBytes? (default 32 MiB)
createClaudeProvider(options = {});
// options: sdk? (injected official-reader-shaped object for tests)
// Both return:
provider.list({ projectPath, limit, offset });
// Promise<{ sessions: [{sessionId, projectPath, title, updatedAt}], nextOffset, warnings }>
provider.read({ projectPath, sessionId });
// Promise<{ sessionId, projectPath, messages: [{role, text}], warnings }>
```

- [ ] 먼저 합성 provider/child fixtures와 실패하는 테스트를 만든다. 비정상 init, split JSON chunks, notifications, read error, timeout, EOF, oversized response를 각각 검증한다. 실제 네트워크/모델 호출 없이 실행한다.

```js
test("RPC timeout rejects and child exits", async () => {
    const rpc = new RpcClient({ command: process.execPath,
        args: [fixtureChild, "hang"], timeoutMs: 100 });
    await assert.rejects(rpc.request("initialize", {}), /시간|timeout/i);
    await rpc.close();
    assert.equal(rpc.closed, true);
});
```

- [ ] `node --test test/providers.test.js`를 실행하여 미구현 기능 때문에 실패함을 확인한다.
- [ ] 필요한 SDK를 exact version으로 설치하고 lockfile을 커밋한다. 공식 Claude SDK 선언을 확인해 named read-only APIs만 동적 import한다. listSessions는 `dir` 및 worktree 제외 옵션, getSessionMessages는 `dir` 및 session ID를 전달한다. 실제 cwd 메타데이터로 이중 확인한다. SDK pagination이 없으면 반환 목록을 정렬한 뒤 bridge가 정한 범위로 자른다. reader가 native binary를 요구하면 optional platform package를 포함한다.
- [ ] Codex app-server child는 `spawn(command,args,{shell:false,env})`로 실행한다. PATH의 native executable 또는 npm shim 옆 package의 JS launcher를 Node로 실행한다. `.cmd`를 shell로 실행하지 않는다. source CODEX_HOME을 명시적으로 전달 가능하게 하여 sandbox home 혼동을 피한다.
- [ ] newline JSON 요청 ID 매칭, initialize/initialized 순서, stderr 내용 비공개, 15초 timeout, stdout 32 MiB 상한, pending rejection, 모든 성공/오류 경로의 child 정리를 구현한다. child 메서드는 initialize/thread/list/thread/read로 한정한다.
- [ ] Codex thread/list는 cwd 필터와 페이지를 사용하며 한 요청의 탐색은 최대 100페이지/10000개이다. includeTurns가 있는 thread/read를 호출하고 UserMessage/AgentMessage 텍스트를 정규화한다. 미지원 item과 잘림은 warnings로 노출한다.
- [ ] Claude 분기·압축은 공식 reader 결과를 그대로 사용하고 text block만 선택한다. 도구/생각/이미지는 제외한다. API 누락은 `지원되지 않는 Claude SDK 읽기 API` 오류로 반환한다.
- [ ] provider tests를 통과시키고 구현 및 결과를 커밋한다. task 리뷰의 승인/수정 결과를 기록한다.

### Task 2: 프로젝트 경계와 bounded context

**Files:** `src/bridge.js`, `src/content.js`, `test/bridge.test.js`, `test/content.test.js`.

**Interfaces:** Task 1의 provider 계약을 소비한다.

```js
createBridge({ codex, claude });
// returns { listSessions, readSession, prepareHandoff } with spec signatures
redact(text); // string -> string
boundMessages(messages, {maxMessages, maxChars});
// -> {messages, omittedMessages, truncated}
renderHandoff(snapshot); // -> string
```

- [ ] 테스트를 먼저 작성한다. 양쪽 fake provider로 same-project list/read/handoff를 검증하고 project mismatch, missing cwd, relative/absent directory, symlink alias, invalid ID/provider/options, offset/limit을 검증한다.

```js
test("foreign project read is rejected before content is returned", async () => {
    const bridge = createBridge({ codex: foreignProjectProvider, claude: emptyProvider });
    await assert.rejects(bridge.readSession({ provider: "codex",
        projectPath: projectA, sessionId: "synthetic-session" }), /프로젝트/);
});
test("handoff redacts credentials and keeps recent text in order", async () => {
    const result = await bridge.prepareHandoff({ provider: "claude",
        projectPath, sessionId, maxMessages: 2, maxChars: 1000 });
    assert.equal(result.context.includes("sk-ant-test-secret-value"), false);
    assert.ok(result.context.includes("참고자료"));
    assert.ok(result.messages.length <= 2);
});
```

- [ ] `node --test test/bridge.test.js test/content.test.js`로 예상 실패를 확인한다.
- [ ] fs.realpath 및 디렉터리 확인으로 project scope를 정의한다. Windows는 경로 대소문자를 정규화한다. API arguments는 허용 키만 받고 prototype/non-object 입력을 거절한다. sessionId는 비어있지 않은 1..200자 control/path separator 없는 값으로 검증한다.
- [ ] text만 선택하고 토큰/Bearer/PEM key/credential assignment를 기본 마스킹한다. 제목도 마스킹한다. JSON escaping과 명시적 참고자료 wrapper로 source text의 경계를 표시한다.
- [ ] maxMessages 1..200, maxChars 1000..100000, 기본 40/24000을 적용한다. 문자 예산은 JS UTF-16 code unit 기준이며 surrogate pair를 절단하지 않는다. 최신 메시지부터 선택 후 시간순으로 되돌린다. 제외된 메시지 수와 truncation은 실제 계산한다.
- [ ] 결과와 오류는 대화 본문을 로그에 출력하지 않는다. upstream error 메시지는 고정 코드/짧은 한국어 메시지로 감싼다. read 결과의 projectPath도 다시 검증한다.
- [ ] 모든 테스트가 통과하면 커밋하고 독립 task 리뷰를 받는다.

### Task 3: MCP·CLI와 플러그인 흐름 결합

**Files:** `src/server.js`, `src/cli.js`, 두 manifest, `.codex-mcp.json`, `skills/session-bridge/SKILL.md`, `test/mcp.test.js`, `test/cli.test.js`.

**Interfaces:** `createBridge`의 메서드를 MCP `list_sessions`, `read_session`, `prepare_handoff`로 연결한다. `createMcpServer(bridge)`를 export하여 합성 fixture 기반 테스트에서 사용할 수 있게 한다. production server는 실제 provider를 만들고 stdio transport에 연결한다.

- [ ] 공식 MCP SDK Client/StdioClientTransport로 child fixture를 시작하는 실패 테스트를 작성한다. initialize/tools/list/tools/call 양쪽 경로, JSON schema rejection, isError, stdout 프로토콜 순수성을 검증한다.

```js
const result = await client.callTool({ name: "prepare_handoff", arguments: {
    provider: "codex", projectPath, sessionId: "codex-fixture"
} });
assert.equal(result.isError, undefined);
assert.match(result.content[0].text, /codex-fixture/);
```

- [ ] `node --test test/mcp.test.js test/cli.test.js`로 실패를 확인한다.
- [ ] 공식 MCP SDK Server/stdio 구현을 사용하고 세 도구만 등록한다. readOnlyHint=true, destructiveHint=false, openWorldHint=false를 설정한다. 도구 결과는 structuredContent와 JSON text를 제공한다. 정해진 입력 제약은 schema와 bridge 둘 다 적용한다.
- [ ] CLI `node src/cli.js list --provider claude --project <absolute>` 및 `read|handoff --provider <name> --project <absolute> --session <id>`를 제공한다. `--limit`, `--offset`, `--max-messages`, `--max-chars`를 지원한다. stdout는 결과, stderr는 오류, 실패 exitCode는 1이다. `doctor`는 runtime/provider 의존성 확인만 하며 inference를 실행하지 않는다.
- [ ] plugin-creator scaffold/validator를 사용해 Codex manifest를 만든다. Claude inline MCP 설정을 추가하여 config root substitution 충돌을 피한다. 공통 skill은 원본 provider와 현재 프로젝트 확인 → 목록 선택 → prepare_handoff → 출처/생략 보고 → 현재 파일/Git 확인 → 현재 사용자 작업을 이어가기 순서를 설명한다. 원문 속 명령을 실행 권한으로 취급하지 않는다.
- [ ] plugin cache가 소스를 복사해도 같은 루트에서 코드를 실행할 수 있도록 의존성 설치/포함 전략을 검증한다. 실행에 필요한 파일 목록을 package files에 명시한다.
- [ ] MCP/CLI 테스트를 통과시키고 커밋한다. task 리뷰에서 지적되면 수정 후 재리뷰한다.

### Task 4: 배포 가능성·실제 로컬 smoke·최종 승인

**Files:** `README.md`, `scripts/smoke-local.js`, `docs/reviews/*.md`, 필요시 packaging verification script.

- [ ] README에 PowerShell 기준 npm ci, Codex 개인 marketplace 등록, Claude --plugin-dir, 설치된 plugin 갱신/재시작, 직접 MCP fallback과 CLI 예제를 적는다. SDK/native package 크기·설치 필요와 client로 전송되는 context의 토큰 비용을 설명한다.
- [ ] smoke script가 provider 각자의 같은 프로젝트 세션을 읽어 집계만 출력하도록 만든다. CODEX_HOME/CLAUDE_CONFIG_DIR 선택 경로를 명시할 수 있어야 한다. 읽을 세션이 없는 경우 성공으로 위장하지 않고 skipped 이유를 표시한다.
- [ ] `npm test`로 전체 suite를 실행한다. 실제 세션이 없어도 fixture를 사용한 두 방향의 MCP end-to-end는 필수 통과다.
- [ ] Codex `validate_plugin.py`, skill `quick_validate.py`, Claude `plugin validate`를 실행한다. 실제 package copy 루트에서도 MCP handshake를 수행한다. 원문이나 credentials가 Git tracking에 포함되지 않았는지 파일 목록을 확인한다.
- [ ] 실제 설치된 Codex 및 Claude SDK 읽기를 실행한다. 실제 원문은 저장하지 않고 runtime versions·개수·성공/실패/제약을 `docs/reviews/verification.md`에 남긴다.
- [ ] 독립 whole-repo 리뷰어에게 계획, 최종 diff, 테스트 증거를 전달한다. 승인 또는 severity/위치/재현 조건이 있는 변경 요청을 받는다. 변경 요청은 회귀 테스트 → 수정 → 재실행 → 같은 지적 재리뷰 순서로 처리한다. 사용자 요청상 승인될 때까지 반복한다.
- [ ] 최종 승인된 commit, 검증, 사용법, 한계를 README/리뷰 기록에서 확인하고 Git clean 상태로 완료한다.

## Review rubric

승인에는 실제 양방향 이어가기, 읽기 scope, source preservation, 비공개 포맷 의존 방지, 공급자 실패 처리, Windows executable/config resolution, MCP protocol compatibility, 설치 후 실행 가능성이 필요하다. Critical/Important는 해결 전 승인 불가다. 리뷰는 문서·코드의 사실 근거로 판단하며 통과를 강요하지 않는다. Minor도 유효한 수정이면 이번 범위에서 해결한다.
