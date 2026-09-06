# 독립 패키징 계획 변경 리뷰

- 판정: **APPROVED**
- 검토일: 2026-09-06
- 검토자: 독립 `plan_review` 에이전트
- 범위: Codex MCP 설정을 별도 `.codex-mcp.json`에서 manifest 인라인 객체로 옮기는 변경. 제공자·본문 처리·권한 범위 변경은 포함하지 않는다.

## 승인하는 설정

Codex `.codex-plugin/plugin.json`의 `mcpServers`를 아래 객체로 바꾼다.

```json
{
    "session-bridge": {
        "command": "node",
        "args": ["./src/server.js"],
        "cwd": "."
    }
}
```

Claude의 기존 인라인 `mcpServers`와 `${CLAUDE_PLUGIN_ROOT}/src/server.js`는 유지한다. 사용하지 않는 `.codex-mcp.json`을 삭제하고 공통 루트 `.mcp.json`은 만들지 않는다. package files, 설계·계획·README와 관련 테스트의 설정 경로 설명도 함께 갱신한다.

## 독립 확인 근거

- 로컬 Plugin Creator의 `references/plugin-json-spec.md` 66·78·213행은 `mcpServers` 객체를 명시적으로 지원한다. SKILL.md의 일반적인 companion-file 설명보다 이 구체적인 인라인 계약이 이번 구성에 해당한다.
- `scripts/validate_plugin.py` 301–324행은 문자열의 경우 `.mcp.json`만 허용하지만 dict의 경우 서버 맵을 직접 검증한다. 제안한 정확한 객체로 `validate_manifest_mcp_servers`를 호출했고 `inline_mcp_errors: []`를 확인했다. 이는 해당 설정 항목 검증 결과이며 전체 plugin validator 실행을 대신하지 않는다.
- [Codex 0.153.0 공개 MCP 파서](https://raw.githubusercontent.com/openai/codex/rust-v0.153.0/codex-rs/codex-mcp/src/plugin_config.rs)는 직접 서버 맵을 처리하며 상대 `cwd`를 host plugin root에 결합한다(46–55, 263–270행). 따라서 제안된 command/args/cwd는 기존 상대 경로 실행 의미를 유지한다.
- 이번 조사에서는 manifest loader에서 인라인 객체를 전달하는 전체 실행 경로를 직접 실행하지 않았다. 현재 승인된 계획에 이미 포함된 실제 설치/cache 설정 해석 검증을 계속 수행해야 한다.

## 판정 이유와 검증 유지

이 변경은 두 클라이언트의 설정을 각 manifest 안에 보존하면서 로컬 검증기의 제한을 해결한다. 원본 세션 읽기 범위, 네트워크·모델 실행 금지, 마스킹, 출력 제한을 바꾸지 않는다. 별도 파일 방식보다 추가 실행 권한이 필요하지 않아 제한된 계획 변경으로 승인한다.

변경 후 전체 Codex/Claude manifest validator, 별도 artifact 루트에서 다른 cwd의 MCP handshake, 실제 Codex cache에서 인라인 설정 해석 및 실행 확인은 그대로 필수다. 이 문서는 코드 전체나 설치 완료를 승인하는 기록이 아니다.
