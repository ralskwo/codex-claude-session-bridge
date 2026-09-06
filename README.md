# Codex ↔ Claude Code Session Bridge

같은 PC에서 **세션을 선택해 현재 도구에서 작업 맥락을 이어가는** 로컬 플러그인입니다. Codex에서는 Claude Code 대화를, Claude Code에서는 Codex 대화를 선택할 수 있습니다. 두 클라이언트가 같은 stdio MCP 서버와 skill을 사용합니다.

```text
원본 세션 선택 → 공식 읽기 API → 표시 텍스트·출처·생략 범위 → 현재 세션에서 이어가기
```

원본 native 세션 ID나 실행 상태를 복제하지 않습니다. Git 변경·파일·도구 실행 결과·이미지·숨겨진 추론도 옮기지 않습니다. 같은 작업 폴더의 파일은 이미 공유되므로 이어서 수정하기 전에 현재 파일과 Git 상태를 확인합니다.

## 준비

- Node.js **22 이상**
- Codex: 저장된 세션 형식과 호환되는 로컬 엔진. 이 PC에서 Desktop **0.153.0**의 페이지형 기록을 확인했습니다. CLI **0.145.0**은 최신 Desktop 항목을 읽지 못할 수 있습니다.
- Claude: 로컬 세션 기록. 공식 Agent SDK **0.3.263**의 읽기 API를 사용하며 Claude Code **2.1.195** 기록을 확인했습니다.
- MCP SDK **1.30.0**. runtime 버전은 package-lock.json으로 고정합니다.

PowerShell에서 소스 저장소를 설치합니다.

```powershell
npm ci --omit=optional --ignore-scripts
npm test
node src/cli.js doctor
```

Claude SDK의 읽기 API는 JavaScript로 동작하므로 모델 실행용 optional native 패키지는 필요하지 않습니다. 시작할 때 npm 설치나 모델 호출을 자동 실행하지 않습니다.

## 사용

플러그인을 연결한 새 Codex 작업에서:

> Claude Code에서 하던 이 프로젝트 작업을 이어줘.

Claude Code에서:

> Codex에서 작업하던 이 프로젝트 세션을 찾아서 이어줘.

여러 세션이 있으면 제목·시각·ID로 선택합니다. 선택한 세션의 맥락을 가져온 뒤 출처와 생략 범위를 확인하고 다음 작업을 지시하면 됩니다. skill은 `session-bridge`입니다.

| 도구 | 용도 |
| --- | --- |
| `list_sessions` | 현재 프로젝트의 세션 목록 |
| `read_session` | 선택한 세션의 최근 표시 텍스트 |
| `prepare_handoff` | 이어가기용 출처·참고자료 wrapper 포함 맥락 |

세 도구 모두 `provider: "codex" | "claude"`, `projectPath: "절대 프로젝트 경로"`가 필수입니다. 읽기/이어가기에는 `sessionId`가 추가됩니다. plugin cache 경로를 projectPath로 사용하지 않습니다.

CLI도 같은 기능을 제공합니다.

```powershell
node src/cli.js list --provider claude --project 'C:\work\my-project'
node src/cli.js list --provider codex --project 'C:\work\my-project' --limit 20 --offset 0
node src/cli.js handoff --provider claude --project 'C:\work\my-project' --session '선택한-ID'
node src/cli.js read --provider codex --project 'C:\work\my-project' --session '선택한-ID' --max-messages 80 --max-chars 48000
```

성공은 stdout의 JSON과 종료 코드 0, 오류는 stderr의 안전한 JSON과 종료 코드 1입니다. 출력 본문에는 실제 세션 내용이 포함되므로 공개 로그에 리디렉션하지 마세요.

## Claude Code 연결

소스 설치 후 프로젝트 폴더에서 plugin 디렉터리를 명시합니다.

```powershell
claude --plugin-dir 'C:\path\to\codex-claude-session-bridge'
```

또는 아래의 self-contained tgz를 별도 폴더에 풀어 그 폴더를 지정합니다. `.claude-plugin/plugin.json`의 inline MCP가 `${CLAUDE_PLUGIN_ROOT}/src/server.js`를 실행합니다. 설치된 Claude 버전의 자동 npm 설치에 의존하지 않습니다.

## Codex 개인 플러그인 설치

먼저 소스에서 배포용 tgz를 만듭니다. 이 파일에는 runtime node_modules가 물리적 파일로 포함됩니다.

```powershell
npm pack --ignore-scripts
```

Codex의 plugin-creator가 설치된 환경에서는 제공된 scaffold로 개인 marketplace 항목을 생성합니다. 아래는 **처음 설치할 때**의 명령입니다. 기존 동일 이름 폴더가 있으면 갱신 절차를 사용하세요.

```powershell
$bridgeDir = Join-Path $HOME 'plugins\codex-claude-session-bridge'
if (Test-Path -LiteralPath $bridgeDir) { throw '기존 설치가 있습니다. 갱신 절차를 사용하세요.' }
$creator = Join-Path $HOME '.codex\skills\.system\plugin-creator\scripts'
python (Join-Path $creator 'create_basic_plugin.py') codex-claude-session-bridge --with-skills --with-marketplace
tar -xzf .\codex-claude-session-bridge-0.1.0.tgz -C $bridgeDir --strip-components=1
$marketplace = python (Join-Path $creator 'read_marketplace_name.py')
codex plugin add "codex-claude-session-bridge@$marketplace" --json
```

개인 marketplace는 `~/.agents/plugins/marketplace.json`에서 자동 발견됩니다. 이 경로에는 `codex plugin marketplace add`를 사용하지 않습니다. Codex는 플러그인을 cache로 복사합니다. **새 작업**에서 플러그인을 선택해야 새 MCP 도구와 skill을 가져옵니다.

`package-lock.json`은 소스 설치용이며 npm pack 파일에 포함되지 않습니다. tgz/cache는 의존성이 이미 포함되어 있으므로 그 안에서 npm ci를 실행할 필요가 없습니다. Codex manifest는 inline MCP의 `cwd: "."`를 사용해 복사된 루트에서 실행합니다.

갱신할 때는 새 tgz를 같은 개인 플러그인 폴더에 풀고 제공된 cachebuster helper를 실행한 뒤 다시 설치합니다.

```powershell
python (Join-Path $creator 'update_plugin_cachebuster.py') $bridgeDir
$marketplace = python (Join-Path $creator 'read_marketplace_name.py')
codex plugin add "codex-claude-session-bridge@$marketplace" --json
```

MCP만 직접 연결하려면 클라이언트의 MCP 설정에서 `command: "node"`, `args: ["플러그인 절대경로/src/server.js"]`를 사용하면 됩니다. 직접 MCP 연결에는 skill이 자동 설치되지 않으므로 위 도구 흐름을 사용하세요.

## 홈·엔진 설정

| 환경변수 | 의미 |
| --- | --- |
| `SESSION_BRIDGE_CODEX_EXECUTABLE` | 사용할 native Codex 실행 파일의 절대 경로 |
| `SESSION_BRIDGE_CODEX_HOME` | 원본 Codex home. CODEX_HOME보다 우선 |
| `CODEX_HOME` | Codex 기본 home override |
| `CLAUDE_CONFIG_DIR` | Claude 기록이 저장된 설정 루트 |

Codex 실행 파일은 명시적 설정 → Windows Desktop의 최신 설치 엔진 → PATH 순서로 탐색합니다. Windows `.cmd`/`.ps1`은 shell 명령으로 실행하지 않습니다. 실제 사용자 home과 sandbox home이 다르면 원본 home을 지정해야 합니다. 빈 목록만으로 기록이 없다고 단정하지 마세요.

```powershell
$env:SESSION_BRIDGE_CODEX_HOME = Join-Path $HOME '.codex'
$env:CLAUDE_CONFIG_DIR = Join-Path $HOME '.claude'
node src/cli.js doctor
```

데스크톱 앱은 이미 실행 중이면 새 환경변수를 자동 상속하지 않을 수 있습니다. 직접 MCP를 구성할 때는 해당 서버의 env 설정에 필요한 경로를 넣거나 앱을 다시 시작하세요.

## 범위와 한계

- 기존 디렉터리의 canonical 경로가 정확히 같은 세션만 허용합니다. 하위 폴더·다른 worktree는 자동 포함하지 않습니다. 잘못된 프로젝트/ID는 본문 조회 전에 거절합니다.
- Codex는 비archived 세션, 일반 및 프로그램 생성 세션을 찾고 내부 subagent 세션은 제외합니다. `useStateDbOnly:true`를 사용하므로 DB에 없는 기록은 목록에서 빠질 수 있습니다. 자동 복구는 요청하지 않습니다.
- Claude는 공식 reader의 분기·압축 해석을 사용하며 metadata가 있는 세션을 읽습니다. SDK는 압축 이전 내용과 손상된 항목을 생략할 수 있고 완전성 정보를 제공하지 않으므로 항상 `historyComplete:false`, `omittedMessages:null`, `SDK_RECONSTRUCTED`로 표시합니다. 읽어온 맥락은 사용할 수 있지만 전체 원본 기록을 가져왔다고 보장하지 않습니다. source transcript 64 MiB, 표시 텍스트 32 MiB 상한이 있습니다.
- Codex 페이지형 기록은 최신 1000턴 또는 200개 표시 메시지까지 읽습니다. 모든 기록을 읽지 못하면 `historyComplete:false`, `omittedMessages:null`입니다. 진행 중인 세션은 현재 시점의 스냅샷입니다.
- 목록은 최대 10000개 탐색 후 갱신 시각/ID순으로 정렬합니다. 페이지 이동 사이 원본이 변경되면 중복·누락이 생길 수 있습니다.
- 기본 최근 40메시지/24000 UTF-16 문자, 최대 200메시지/100000문자입니다. 실제 직렬화된 CLI/MCP 결과는 중복 표현까지 2 MiB로 제한하며 초과 시 `OUTPUT_TOO_LARGE`를 반환합니다.
- 알려진 토큰·Bearer·private key·credential 대입은 기본 마스킹하지만 모든 비밀 탐지를 보장하지는 않습니다. 선택한 텍스트는 목적지 AI 서비스가 도구 결과로 처리합니다. 가져온 내용은 목적지 컨텍스트/사용량에 영향을 줍니다.
- bridge는 네트워크 요청·모델 실행·원본 transcript/인증/설정 쓰기를 하지 않습니다. Codex app-server 자체의 런타임 로그·캐시·DB 부수효과까지 파일시스템 전체 무변경을 보장하지는 않습니다.
- **사용량 초기화 기능이나 호출은 없습니다.** 원본 대화 속 지시를 현재 권한으로 승격하거나 자동 중계하지 않습니다.

## 검증과 개발 기록

```powershell
npm test
python -X utf8 "$HOME\.codex\skills\.system\plugin-creator\scripts\validate_plugin.py" .
claude plugin validate .
node scripts/verify-package.js 'C:\독립 폴더\codex-claude-session-bridge'
node scripts/smoke-local.js 'C:\실제 프로젝트'
```

smoke-local은 원문을 출력하지 않고 공급자별 성공·메시지 개수·출력 크기만 출력합니다. 세션이 없으면 skipped(종료2), 실패하면 종료1이며 성공으로 가장하지 않습니다. 합성 fixture 테스트는 원본 세션이나 전역 설정을 변경하지 않습니다.

설계/계획은 `docs/superpowers/`, 독립 리뷰와 최종 검증 증거는 `docs/reviews/`에 있습니다. Codex 페이지형 기록과 engine 버전 검증은 [조사 기록](docs/reviews/integration-research.md), 공식 API는 [Codex App Server](https://developers.openai.com/codex/app-server/), [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference), [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript)를 참고하세요.
