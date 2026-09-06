const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createMcpServer } = require("../../src/server.js");
const { createBridge } = require("../../src/bridge.js");

const projectPath = process.argv[2];
function provider(name) {
    return {
        async list() {
            return { sessions: [{ sessionId: `${name}-fixture`, projectPath,
                title: "합성 작업", updatedAt: 1000 }], nextOffset: null, warnings: [] };
        },
        async read({ sessionId }) {
            if (sessionId === "broken") {
                throw new Error("PRIVATE-UPSTREAM-CREDENTIAL");
            }
            return { sessionId: `${name}-fixture`, projectPath, historyComplete: true,
                warnings: [], messages: [
                    { role: "user", text: "테스트를 고쳐줘. token=secret-test-value" },
                    { role: "assistant", text: `${name} 수정 완료` }
                ] };
        }
    };
}
const bridge = process.argv[3] === "huge"
    ? { async prepareHandoff() { return { value: "x".repeat(3 * 1024 * 1024) }; } }
    : createBridge({ codex: provider("codex"), claude: provider("claude") });
createMcpServer(bridge).connect(new StdioServerTransport()).catch(() => {
    process.stderr.write("테스트 서버 연결 실패\n");
    process.exitCode = 1;
});
