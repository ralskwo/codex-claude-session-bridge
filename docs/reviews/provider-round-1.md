# 독립 제공자 코드 리뷰 — 1차

- 명세 적합성 판정: **CHANGES_REQUESTED**
- 코드 품질 판정: **CHANGES_REQUESTED**
- 검토일: 2026-09-06
- 검토자: 독립 `plan_review` 에이전트
- 기준: provider 구현 커밋 `09e85be`, 현재 `src/providers/*`, 공유 project 코드, Task 1 brief/report/diff와 승인된 계획.
- 실제 개인 세션을 읽거나 모델/사용량 초기화를 호출하지 않았다. 기존 28개 테스트는 보고된 통과 결과를 검토했고 전체 suite를 반복 실행하지 않았다. 아래 구체적 우려에 한해 exact SDK를 사용하는 합성 재현을 실행했다.

## P1 — Important / P2: Claude 압축 이전 메시지가 생략되어도 전체 기록이라고 표시

위치: `src/providers/claude.js:46`, `src/providers/claude.js:75`.

`historyComplete`를 반환된 text block의 문법 오류 유무로만 결정한다. 그러나 실제 SDK는 원본의 모든 표시 메시지를 반환한다는 보장이 없다. 설치된 `@anthropic-ai/claude-agent-sdk@0.3.263`의 공개 배포 코드에서 `getSessionMessages`는 `Wq → cHe`로 파일을 읽는다. `cHe`는 5 MiB보다 큰 파일에 대해 기본적으로 `uq(...).postBoundaryBuf`를 읽어 압축 경계 앞부분을 생략한다. 반환 배열에는 이 생략의 완전성 메타데이터가 없다. JSONL 파싱 중 손상 행도 SDK에서 조용히 제외될 수 있다.

합성 실제 SDK 재현 결과:

```json
{
    "sourceVisibleMessages": 3,
    "sdkMessageCount": 2,
    "sdkHasOld": false,
    "fileSize": 6292855,
    "providerMessageCount": 2,
    "providerHistoryComplete": true,
    "providerWarnings": []
}
```

`output/claude-review-c00sjc`의 격리된 합성 CLAUDE_CONFIG_DIR에 세션 JSONL을 만들었다. 순서는 이전 user 메시지 → 6 MiB attachment → `compact_boundary` → 새 user → 새 assistant이다. 부모 UUID로 연결되어 있다. 원본에 표시 메시지는 3개지만 SDK는 압축 뒤의 2개만 반환한다. 정상 provider의 `read`를 호출하면 위처럼 완전하다고 표시한다. bridge에서는 maxMessages가 충분한 경우 `omittedMessages:0`, `truncated:false`가 되어 사용자에게 생략이 없다는 잘못된 정보를 준다.

이는 최신 작업 맥락을 가져오는 방식 자체의 문제가 아니다. 승인된 명세가 전체 생략 수를 모를 때 `historyComplete:false`, `omittedMessages:null`을 사용하도록 한 계약 위반이다.

수정 요구:

- 공식 reader가 재구성한 대화와 원본 전체 기록의 완전성을 구분한다. 공식 읽기 인터페이스에서 완전성을 입증할 수 없다면 보수적으로 `historyComplete:false`와 고정된 SDK 재구성/생략 미확인 warning을 반환한다.
- `includeSystemMessages:false` 결과나 5 MiB 이하라는 사실만으로 완전성을 보장하지 않는다. 압축 체인·분기·손상 행은 메시지 배열만으로 모두 판별할 수 없다.
- README와 handoff 안내에도 공식 reader가 재구성한 맥락이라는 의미를 반영한다. SDK 내부 환경변수를 바꿔 압축 처리를 끄거나 자체 비공개 JSONL reader를 새로 구현할 필요는 없다.
- 실제 exact SDK를 사용하는 위 합성 압축 regression을 추가한다. 공개 결과에서 생략 수를 0으로 단정하지 않는지까지 확인한다.

## 품질 측면의 동일 지적

위 문제를 놓친 이유는 Claude 테스트가 `getSessionMessages`를 완성된 배열로 stub하기 때문이다(`test/providers.test.js:219` 이후). `test/providers.test.js:311`의 원본 불변 테스트도 생성한 파일을 SDK/RPC가 실제로 열지 않아 공식 reader 동작이나 원본 보존을 검증하지 못한다. 위 합성 SDK regression에서 transcript/auth/config 전후 바이트 보존을 함께 확인하면 계획의 압축 처리와 실제 읽기 경계 검증을 보완할 수 있다. 별도 중복 수정 요구는 아니며 P1의 회귀 테스트에 포함하면 된다.

## 확인한 적합 부분

- Codex와 Claude 모두 metadata ID/canonical project 검사 후 본문 API를 요청한다. metadata 불일치 시 본문 호출 0회라는 테스트도 있다.
- Codex가 DB-only/sourceKinds/cwd/정렬 옵션을 명시하고 내부 하위 에이전트를 제외한다. 페이지형 기록에 legacy full read를 사용하지 않는다.
- Codex 최신 페이지와 최신 item부터 예산을 적용한 뒤 시간순으로 반환한다. 반복 cursor, 중복 item, 미완성 turn과 상한 도달 시 보수적으로 불완전 표시한다.
- RPC는 shell 없는 숨김 실행, 누적 stdout 제한, 읽기 메서드 제한, 고정 오류, pending 거절과 child 종료 처리를 갖췄다. 이 검토에서 별도의 재현 가능한 프로세스 수명 결함은 확인하지 못했다.
- 명시적 home/executable 우선순위와 Desktop 버전 탐색이 구현되어 있다. Windows canonical casing으로 목록이 비는 가능성은 부모 작업의 실제 production MCP 양쪽 목록→handoff 성공 증거로 해소되었으며 지적으로 채택하지 않았다.

P1 해결 후 관련 회귀 검증과 수정 diff를 재리뷰한다. 본 리뷰는 제공자 범위이며 전체 MCP/CLI/패키징의 최종 승인은 별도로 남아 있다.
