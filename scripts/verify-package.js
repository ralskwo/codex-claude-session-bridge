const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

async function main() {
    if (!process.argv[2] || !path.isAbsolute(process.argv[2])) {
        throw new Error("검증할 배포 루트의 절대 경로가 필요합니다.");
    }
    const root = await fs.realpath(process.argv[2]);
    const artifactRequire = createRequire(path.join(root, "package.json"));
    for (const dependency of ["@modelcontextprotocol/sdk/server/index.js", "@anthropic-ai/claude-agent-sdk"]) {
        const resolved = await fs.realpath(artifactRequire.resolve(dependency));
        const relative = path.relative(root, resolved);
        if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("배포본 외부 의존성이 발견되었습니다.");
        }
    }
    for (const host of ["codex", "claude"]) {
        const manifest = JSON.parse(await fs.readFile(path.join(root, `.${host}-plugin/plugin.json`), "utf8"));
        const config = manifest.mcpServers["session-bridge"];
        if (!config || config.command !== "node") {
            throw new Error("지원되지 않는 배포 서버 설정입니다.");
        }
        const args = config.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", root));
        const client = new Client({ name: "session-bridge-package-test", version: "0.1.0" });
        const transport = new StdioClientTransport({ command: process.execPath, args,
            cwd: config.cwd ? path.resolve(root, config.cwd) : process.cwd(), env: process.env, stderr: "pipe" });
        let stderr = "";
        transport.stderr?.on("data", (chunk) => { stderr += chunk; });
        try {
            await client.connect(transport);
            const result = await client.listTools();
            if (result.tools.length !== 3 || stderr) {
                throw new Error("배포 서버 handshake 검증 실패");
            }
        } finally {
            await client.close();
        }
    }
    process.stdout.write(`${JSON.stringify({ status: "passed", hosts: ["codex", "claude"],
        dependenciesInsideArtifact: true, toolsPerHost: 3 })}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
