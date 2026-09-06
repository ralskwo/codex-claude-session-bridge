const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { safeError } = require("../src/content.js");

async function main() {
    const projectPath = process.argv[2];
    const pluginRoot = path.resolve(process.argv[3] ?? path.join(__dirname, ".."));
    if (!projectPath || !path.isAbsolute(projectPath)) {
        throw new Error("절대 프로젝트 경로가 필요합니다.");
    }
    const client = new Client({ name: "session-bridge-local-smoke", version: "0.1.0" });
    const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(pluginRoot, "src/server.js")], env: process.env, stderr: "pipe" });
    const results = [];
    try {
        await client.connect(transport);
        for (const provider of ["codex", "claude"]) {
            try {
                const list = await client.callTool({ name: "list_sessions", arguments: { provider, projectPath, limit: 1 } });
                if (list.isError) {
                    results.push({ provider, status: "failed", error: JSON.parse(list.content[0].text) });
                    continue;
                }
                const session = list.structuredContent.sessions[0];
                if (!session) {
                    results.push({ provider, status: "skipped", reason: "지정한 home/프로젝트에 발견된 세션이 없습니다." });
                    continue;
                }
                const handoff = await client.callTool({ name: "prepare_handoff", arguments: {
                    provider, projectPath, sessionId: session.sessionId, maxMessages: 2, maxChars: 1000
                } });
                if (handoff.isError) {
                    results.push({ provider, status: "failed", error: JSON.parse(handoff.content[0].text) });
                    continue;
                }
                const snapshot = handoff.structuredContent;
                results.push({ provider, status: snapshot.messages.length ? "passed" : "skipped",
                    messages: snapshot.messages.length, textChars: snapshot.messages.reduce((total, item) => total + item.text.length, 0),
                    historyComplete: snapshot.historyComplete, truncated: snapshot.truncated,
                    outputBytes: Buffer.byteLength(JSON.stringify(handoff)) });
            } catch (error) {
                results.push({ provider, status: "failed", error: safeError(error) });
            }
        }
    } finally {
        await client.close();
    }
    process.stdout.write(`${JSON.stringify({ node: process.version, results }, null, 2)}\n`);
    process.exitCode = results.some((result) => result.status === "failed") ? 1
        : results.some((result) => result.status === "skipped") ? 2 : 0;
}

main().catch((error) => {
    process.stderr.write(`${JSON.stringify(safeError(error))}\n`);
    process.exitCode = 1;
});
