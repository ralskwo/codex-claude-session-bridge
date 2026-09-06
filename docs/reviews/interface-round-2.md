# Task 2 / Task 3 인터페이스 독립 리뷰 2차

- 검토일: 2026-09-06
- 수정 기준: `379c4ec`의 인터페이스 수정. `interface-fix.diff`, `task-3-report.md`, 현재 소스 및 회귀 테스트를 대조했다. `f108319` manifest 서식 변경은 이번 범위에 포함하지 않았다.
- 범위: 1차 R1/R2 해결과 MCP/CLI 수정의 회귀 여부. provider와 최종 패키징은 별도 리뷰 범위다.

## 판정

| 범위 | 사양 준수 | 코드 품질 |
| --- | --- | --- |
| Task 2 프로젝트 경계·bounded context | 기존 승인 유지 | 기존 승인 유지 |
| Task 3 MCP·CLI 인터페이스 | 승인 | 승인 |

새로운 수정 필요 사항은 발견하지 못했다. 이번 승인은 MCP/CLI 인터페이스 범위이며, provider 및 최종 패키징을 포함한 전체 저장소 승인을 대신하지 않는다.

## 기존 지적 확인

- **R1 해결:** `AjvJsonSchemaValidator`가 tools/list에 공개하는 동일한 `inputSchema`를 컴파일하고 dispatch 전에 검사한다. 잘못된 인자는 고정 `INVALID_ARGUMENT` 오류로 반환되어 주입된 bridge에도 전달되지 않는다. 세션 ID의 제어문자·경로 구분자 금지와 projectPath의 절대 경로 형태·제어문자 제한도 추가됐다. 실제 디렉터리 및 프로젝트 경계 검증은 기존 bridge에 남아 있다. Ajv의 원문 오류를 응답에 복사하지 않는다.
- **R2 해결:** CLI의 명령·옵션 파싱 실패와 doctor의 잘못된 추가 인자는 `bridgeError("INVALID_ARGUMENT")`로 변환된다. 지원 runtime 검사 실패는 고정 `RUNTIME_UNSUPPORTED` 코드와 한국어 메시지를 사용한다. 기존 stdout/stderr 분리와 실패 종료 코드는 유지된다.

## 검증 증거

- 보고된 수정 후 테스트: MCP/CLI 8/8, 전체 61/61 통과. 기존 전체 테스트는 반복하지 않았다.
- 독립 합성 probe에서 공식 SDK Client/InMemoryTransport로 잘못된 provider, 역슬래시/개행 포함 ID, drive-relative 경로, 제어문자 포함 경로, 잘못된 문자 예산, 추가 키의 총 7개 입력을 검사했다. 모두 `INVALID_ARGUMENT`, bridge 호출 0회였다.
- drive-letter 역슬래시 경로, drive-letter 슬래시 경로, UNC 경로, POSIX 경로의 4개 정상 형태는 스키마를 통과했다. 공백과 한글을 포함한 Windows 경로도 포함했다. 이 probe는 스키마 계층만 확인하며 실제 프로젝트 존재 검증은 주입한 bridge에서 생략했다.
- 잘못된 숫자 옵션, 지원하지 않는 명령, doctor 추가 인자 3개는 모두 stdout 없이 exitCode 1과 `INVALID_ARGUMENT`을 반환했다.
- 실제 세션/인증/전역 설정에 접근하지 않았고 모델 호출·사용량 초기화를 실행하지 않았다. 프로덕션 파일은 수정하지 않았다.
