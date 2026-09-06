# 최종 검증 증거

검증한 runtime 코드 기준: `7b8d1358bc97695e079f277a92d54aa4075e863d`. 이후 승인 기록·계획 체크박스 갱신은 문서 변경이다.

## 자동 테스트

`npm test`: **63 tests / 63 pass / 0 fail / 0 skipped**.

- 프로젝트 realpath·ID 검증, 본문 전 프로젝트 거절, 입력 범위, 민감정보 마스킹, Unicode/크기 제한.
- 공식 MCP Client의 stdio initialize → tools/list → list/read/handoff, 두 provider 합성 경로.
- MCP advertised schema를 실제 검증하고 잘못된 입력에서 injected bridge 미호출.
- Codex legacy/paginated, DB-only/sourceKinds, cursor/중복/진행중/상한, RPC 종료·timeout·크기 제한.
- 정확한 Claude SDK 0.3.263으로 합성 압축/손상 기록을 실제 읽음. 생략 여부 미확인 표시와 transcript/credentials/settings 바이트 보존.
- CLI 파싱·오류 코드·출력 크기·실제 프로세스 실패 종료.

인터페이스 검증 8/8, 공통 계층25/25, 공급자 및 실제 Claude SDK30/30이다. 초기 실패 및 리뷰 수정 후 성공은 각 task 보고서와 리뷰 문서에 기록했다.

## Manifest와 skill

- plugin-creator `validate_plugin.py`: 통과.
- skill-creator `quick_validate.py` (Python `-X utf8`): 통과.
- Claude Code `plugin validate`: 소스 및 설치된 개인 플러그인 모두 통과.
- skill dry-run 3개 시나리오: 사용 가능, 필수 수정 없음. 선택 모호성, 불완전 맥락/과거 지시, 파일 이전 기대를 점검했다.
- custom MCP 파일명 검증 실패는 두 manifest inline 구성으로 수정했으며 별도 계획 수정 승인을 받았다.

## 배포 파일

- 파일: `codex-claude-session-bridge-0.1.0.tgz`
- 압축 크기: **4,688,846 bytes**
- 해제 크기: **21,800,462 bytes**
- 파일 수: **3,646** (bundled runtime dependencies 포함)
- SHA-256: `7F94DEA1B83D9DBF439E586E524270BB889AF991A7CB8B85F019CB9F26615EE6`
- 두 hidden manifest, source runtime, skill, README 및 두 SDK가 포함된다. 세션 JSONL, 인증 파일, optional Claude native binary는 포함되지 않는다.
- package-lock.json은 소스 Git 전용이다. tgz는 포함된 dependencies로 시작하며 npm 설치를 자동 실행하지 않는다.

초기 artifact는 소스 저장소 외부의 TEMP 아래 공백·한글 경로에 풀어 다른 cwd에서 검증했다. 두 manifest의 서버 설정으로 각각 MCP handshake/tools/list(3개)가 성공했다. require.resolve/realpath로 runtime dependencies가 artifact 내부임을 확인했다. 최종 수정된 artifact는 아래 실제 개인 설치 및 cache 경로에서 같은 검증을 통과했다.

## 실제 설치·캐시 검증

- 개인 source: `C:\Users\ralskwo\plugins\codex-claude-session-bridge`
- 개인 marketplace: `C:\Users\ralskwo\.agents\plugins\marketplace.json`
- 설치 ID: `codex-claude-session-bridge@personal`, version `0.1.0`
- 설치 cache: `C:\Users\ralskwo\.codex\plugins\cache\personal\codex-claude-session-bridge\0.1.0`
- Node **22.18.0**, Codex Desktop engine **0.153.0**, Claude Code **2.1.195**.

제공된 plugin-creator scaffold가 새 개인 항목을 만들고, tgz를 source에 해제한 뒤 실제 Codex `plugin add --json`으로 설치했다. 기존 동일 이름 디렉터리나 항목은 없었다. 기존 세션·인증을 설치 과정에서 수정하지 않았다.

`verify-package.js <installed-cache>` 결과:

```json
{"status":"passed","hosts":["codex","claude"],"dependenciesInsideArtifact":true,"toolsPerHost":3}
```

이는 실제 cache 파일을 해당 manifest 설정으로 실행한 검증이다. 현재 이미 열린 사용자 작업에 새 도구를 강제로 주입하지 않았으며, Codex UI에서는 새 작업에서 플러그인을 선택한다. Claude는 설치 source를 `--plugin-dir`로 사용할 수 있다.

## 실제 세션의 MCP 읽기

원본 home을 명시하고 설치 cache의 서버를 시작해 각 공급자에서 list → 선택 → prepare_handoff를 호출했다. 출력은 원문 없이 집계만 기록했다.

| Provider | 결과 | 표시 메시지 | 텍스트 문자 | historyComplete | 전체 MCP result bytes |
| --- | --- | --- | --- | --- | --- |
| Codex | passed | 2 | 311 | true | 5822 |
| Claude | passed | 2 | 557 | false | 7799 |

두 호출 모두 선택 예산에 따른 truncated=true였다. Claude false는 SDK가 재구성한 원본 전체의 완전성을 알 수 없다는 정상 표시다.

초기 sandbox 기본 home에서는 Codex 목록이 비어 있었다. 실제 사용자 home을 명시한 정상 사용자 권한 호출에서는 성공했다. 이 차이를 README 환경 설정 안내에 반영했다. 모델 생성·세션 재개·도구 실행·사용량 초기화는 호출하지 않았다.

## 남는 지원 한계

- 가져온 맥락으로 현재 세션에서 이어가는 방식이며 native 대화/파일 상태의 완전한 복제가 아니다.
- Codex experimental 페이지 API와 공급자 SDK의 버전 호환성이 필요하다.
- 패턴 기반 마스킹은 모든 비밀을 찾는 보장이 아니며, 선택한 텍스트는 목적지 AI 서비스가 처리한다.
- 원본 기록·인증·설정에 bridge가 쓰지 않지만 Codex app-server 런타임 자체의 모든 파일시스템 부수효과를 보장하지 않는다.

최종 whole-repo 리뷰 판정은 별도의 `final-round-1.md`에 기록한다.
