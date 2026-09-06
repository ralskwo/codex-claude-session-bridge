const { createClaudeProvider } = require("../../src/providers/claude");
const { createBridge } = require("../../src/bridge");

async function main() {
    const [projectPath, sessionId] = process.argv.slice(2);
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const rows = await sdk.getSessionMessages(sessionId, { dir: projectPath, includeSystemMessages: false });
    const provider = createClaudeProvider();
    const snapshot = await provider.read({ projectPath, sessionId });
    const bridge = createBridge({ claude: provider });
    const handoff = await bridge.prepareHandoff({ provider: "claude", projectPath, sessionId });
    // 합성 fixture라도 본문 대신 개수/판정만 출력해 smoke-test 경계를 유지한다.
    process.stdout.write(JSON.stringify({
        sdkCount: rows.length,
        sdkHasOld: rows.some((row) => row.uuid === "old"),
        providerCount: snapshot.messages.length,
        providerHistoryComplete: snapshot.historyComplete,
        providerWarnings: snapshot.warnings,
        publicHistoryComplete: handoff.historyComplete,
        publicOmittedMessages: handoff.omittedMessages,
        publicTruncated: handoff.truncated,
        publicWarnings: handoff.warnings,
    }));
}

main().catch(() => {
    process.stderr.write("공식 Claude SDK 합성 읽기 검증에 실패했습니다.\n");
    process.exitCode = 1;
});
