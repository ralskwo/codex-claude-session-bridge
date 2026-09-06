# 독립 계획 리뷰 — 2차

- 판정: **CHANGES_REQUESTED**
- 검토일: 2026-09-06
- 검토자: 독립 `plan_review` 에이전트
- 기준 커밋: `cc961f9`
- 범위: 수정된 설계·구현 계획, 1차 리뷰, `integration-research.md`, 앞서 확인한 exact Claude SDK 공개 선언/코드.
- 구현·모델 실행·사용량 초기화는 수행하지 않았다.

1차의 핵심 네 지적은 계획 수준에서 해결되었다. 그러나 Codex 목록 범위를 구현하는 필수 옵션이 누락되어 있어 현 문서 그대로의 구현은 약속한 세션을 발견하지 못할 수 있다. 아래 두 문서 수정을 반영한 뒤 다시 판정한다.

## 이전 지적의 확인

| 지적 | 판정 | 확인 근거 |
| --- | --- | --- |
| R1 페이지형 Desktop 기록 | 해결 | metadata 선조회, paginated/legacy 분기, experimental capability, full items 페이지 읽기, cursor/상한/부분 기록 의미를 양쪽 문서에 추가했다. 0.153.0 실측도 기록되었다. |
| R2 목록 자동 복구 | 해결 | `useStateDbOnly:true` 고정, JSONL 복구 fallback 금지, source home 설정과 런타임 부수효과 한계를 명시했다. |
| R3 본문 전 프로젝트 검사 | 해결 | Claude getSessionInfo와 Codex metadata read 후 ID/canonical cwd 검사, 거절 시 본문 호출 0회 테스트가 명시되었다. |
| R4 출력 크기 | 해결 | 입력/metadata 상한과 별개로 최종 CLI/MCP 전체 JSON UTF-8 2 MiB 제한 및 고정 오류, escape/중복 표현 테스트를 명시했다. |
| R5 목록 정렬·범위 | 부분 해결 | timestamp/정렬/offset/중복 처리 계약은 해결되었다. sourceKinds 옵션은 아래처럼 남아 있다. |
| R6 패키징 | 대부분 해결 | bundledDependencies 물리 파일 배포, optional native 제외, 공백·한글 별도 루트 및 실제 cache 검증을 명시했다. artifact lockfile 설명만 수정해야 한다. |

## R5.1 — Important: 약속한 목록 범위를 sourceKinds로 요청하지 않음

위치: 설계 25행, 계획 Task 1의 `thread/list` 단계(82행).

수정된 문서는 같은 프로젝트의 일반/프로그램 생성 세션을 포함한다고 하지만 목록 요청 옵션은 cwd/useStateDbOnly/sortKey/sortDirection/archived뿐이다. 함께 검토한 `integration-research.md`의 실제 요청과 [공식 app-server 문서](https://developers.openai.com/codex/app-server/)에 따르면 sourceKinds가 없거나 빈 배열이면 CLI/IDE 대화형 source만 조회한다. 따라서 `appServer`/`exec` 세션은 정상 기록이어도 목록에서 빠질 수 있다. 이것은 단순 문구가 아니라 세션 선택 기능의 동작 차이다.

수정 요구:

- 지원하는 `sourceKinds` 목록을 설계와 계획에 명시하고 모든 thread/list 요청에 전달한다. 조사 문서에 있는 검증된 enum 값을 사용한다.
- 반환 후 canonical project와 parentThreadId 등 기존 제외 정책을 적용한다.
- 요청 spy가 sourceKinds를 검사하며 appServer/exec 세션이 목록에 포함되는 합성 테스트를 추가한다.

## R6.1 — Minor: npm pack에는 package-lock.json이 포함되지 않음

위치: 계획 Task 3의 package files 단계(150행), 설계 설치/배포 설명.

`package-lock.json`은 npm pack의 기본 제외 파일이므로 package files에 명시해도 artifact에 들어가지 않는다. selfcontained bundledDependencies 배포 자체를 막는 문제는 아니지만 lockfile을 artifact에 포함한다는 수용 기준은 달성할 수 없다.

수정 요구: `package-lock.json`은 소스 repo의 npm ci 재현용으로 유지하고 배포 artifact는 물리적으로 포함된 runtime 의존성을 사용하는 것으로 명시하거나, artifact에서도 잠금 파일이 필요하면 배포용 `npm-shrinkwrap.json`을 선택한다. 어느 쪽이든 파일 목록 검증은 선택한 실제 산출물에 맞춘다.

## 승인 판단 범위

이외에 계획을 막는 추가 아키텍처 문제는 발견하지 못했다. R5.1 및 R6.1이 설계·계획에 반영되면 구현을 시작할 수 있는 수준이다. 계획 승인은 런타임 호환성·마스킹 완전성·실제 설치 성공을 미리 보장하지 않으며 이 항목들은 이미 예정된 테스트와 독립 코드 리뷰에서 검증해야 한다.
