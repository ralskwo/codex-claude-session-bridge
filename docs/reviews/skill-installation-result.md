# 스킬 설치 검증 — 2026-09-06

## 설치 상태

- Codex: 기존 `codex-claude-session-bridge@personal` 플러그인의 `session-bridge` 스킬이 현재 작업에 노출됨. 실제 설치된 MCP 도구로 현재 Codex 작업을 읽었다.
- Claude Code: `~/.claude/skills/session-bridge/SKILL.md` 설치. 공식 `claude mcp add --scope user`로 `session-bridge` stdio 서버 등록.
- Claude Desktop: `%APPDATA%/Claude/claude_desktop_config.json`에 동일 서버 등록. 기존 파일의 byte backup을 보존했다.

두 신규 연결은 `C:/Program Files/nodejs/node.exe`로 개인 플러그인의 `src/server.js`를 실행한다. 원본 홈은 `SESSION_BRIDGE_CODEX_HOME=C:/Users/ralskwo/.codex`, `CLAUDE_CONFIG_DIR=C:/Users/ralskwo/.claude`다.

## 확인한 결과

1. Codex 현재 작업 ID `01a074cd-9797-7a91-a707-17b50a97be38`에 대해 설치된 MCP의 `prepare_handoff` 호출 성공.
2. 실제 Claude Code 설정을 읽어 생성한 stdio client: handshake 성공, 도구 3개, 현재 Codex 작업의 최근 표시 메시지 2개 읽기 성공.
3. 실제 Claude Desktop 설정을 읽어 생성한 stdio client: 동일 검증 성공. 서버 검증 중 원문은 출력하지 않았다.
4. 제한된 읽기 결과에 `truncated:true`가 표시됨. 전체 세션을 가져온 결과로 표현하지 않았다.
5. 원본 저장소, 개인 플러그인, Codex 설치 cache, Claude 개인 스킬의 SKILL.md SHA-256 일치: `374e4b7b420a1d2909a1a32019870baae32c689da1afa371269221d9d29c3193`.
6. 기존 설정과 설치 후 설정의 JSON deep equality 검증: 양쪽 모두 새 `session-bridge` 항목 외 동일. Desktop의 `UnityMCP`와 `unityMCP` 키도 대소문자를 유지했다.
7. `git diff --check` 통과. 런타임/스킬 본문 변경 없음; 이전 63개 테스트 결과는 기존 구현의 검증 기록이며 이번 변경에서 새 실행한 결과로 주장하지 않는다.

Claude Code backup: `~/.claude.json.session-bridge-20260906-183152.bak`.
Desktop backup: `%APPDATA%/Claude/claude_desktop_config.json.session-bridge-2026-09-06T09-31-53-081Z.bak`.

첫 CLI 설치 명령은 PowerShell shim의 인수 처리로 `commandOrUrl` 누락 오류를 반환했고 설정은 바뀌지 않았다. 실제 성공한 명령처럼 실행 경로와 args를 먼저 두고 `--env`를 뒤에 두도록 README를 수정했다.

## 남은 사용자 측 확인과 범위

- 현재 열린 Claude 앱을 종료하거나 사용자 대신 채팅을 생성하지 않았다. 앱을 완전히 재시작한 후 일반 채팅에서 `session-bridge` 도구가 보이고 실제 요청을 수행하는지는 아직 확인하지 않았다.
- Claude Code 개인 스킬과 서버는 설치했지만, 사용자의 계정에서 Claude Code 모델 실행은 확인하지 않았다.
- 일반 Claude 채팅을 원본으로 읽는 기능은 없다. 현재 일반 Desktop 연결은 Codex/Claude Code의 기존 기록을 가져오는 용도다.
- 구매, 모델 자동 실행, 사용량 초기화는 수행하지 않았다.

README와 이 설치 기록은 저장소에서 갱신했다. 이미 배포된 0.1.0의 런타임 및 스킬은 그대로 사용한다.

## 독립 설치 리뷰

`desktop_support_check` — **APPROVED**, 수정 요청 없음. 스킬 4개 복사본 SHA, 양쪽 설정의 원본 대비 deep equality, 실행 경로와 환경변수, README와 계획 문서를 독립 확인했다. MCP 실행은 부모 에이전트의 검증 증거이며, 실제 Claude UI 호출/모델 실행은 미검증이라고 구분했다.
