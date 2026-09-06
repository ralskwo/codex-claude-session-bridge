const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createMcpServer } = require("../src/server.js");

async function connect(t, mode = "normal") {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-mcp-"));
    const client = new Client({ name: "session-bridge-test", version: "1.0.0" });
    const transport = new StdioClientTransport({ command: process.execPath,
        args: [path.join(__dirname, "fixtures/mcp-child.js"), projectPath, mode], stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (data) => { stderr += data; });
    t.after(async () => {
        await client.close();
        await fs.rm(projectPath, { recursive: true, force: true });
    });
    await client.connect(transport);
    return { client, projectPath, stderr: () => stderr };
}

test("stdio handshake exposes only three read-only tools and completes both handoff directions", async (t) => {
    const { client, projectPath, stderr } = await connect(t);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["list_sessions", "prepare_handoff", "read_session"]);
    assert.ok(tools.every((tool) => tool.annotations.readOnlyHint && !tool.annotations.destructiveHint));
    for (const provider of ["codex", "claude"]) {
        const list = await client.callTool({ name: "list_sessions", arguments: { provider, projectPath } });
        const sessionId = list.structuredContent.sessions[0].sessionId;
        assert.equal(sessionId, `${provider}-fixture`);
        const read = await client.callTool({ name: "read_session", arguments: { provider, projectPath, sessionId } });
        assert.equal(read.structuredContent.messages.at(-1).text, `${provider} 수정 완료`);
        const handoff = await client.callTool({ name: "prepare_handoff", arguments: { provider, projectPath, sessionId } });
        assert.equal(handoff.isError, undefined);
        assert.ok(handoff.structuredContent.context.includes(sessionId));
        assert.equal(JSON.stringify(handoff).includes("secret-test-value"), false);
        assert.deepEqual(JSON.parse(handoff.content[0].text), handoff.structuredContent);
    }
    assert.equal(stderr(), "");
});

test("invalid arguments and unknown tools are errors without leaking upstream text", async (t) => {
    const { client, projectPath } = await connect(t);
    for (const args of [
        { provider: "other", projectPath },
        { provider: "codex", projectPath, limit: 0 },
        { provider: "codex", projectPath, extra: true }
    ]) {
        const result = await client.callTool({ name: "list_sessions", arguments: args });
        assert.equal(result.isError, true);
    }
    const broken = await client.callTool({ name: "read_session", arguments: {
        provider: "codex", projectPath, sessionId: "broken"
    } });
    assert.equal(broken.isError, true);
    assert.equal(JSON.stringify(broken).includes("PRIVATE-UPSTREAM-CREDENTIAL"), false);
    const unknown = await client.callTool({ name: "execute_command", arguments: {} });
    assert.equal(unknown.isError, true);
});

test("MCP enforces bytes on the entire serialized result including both representations", async (t) => {
    const { client, projectPath } = await connect(t, "huge");
    const result = await client.callTool({ name: "prepare_handoff", arguments: {
        provider: "codex", projectPath, sessionId: "fixture"
    } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /OUTPUT_TOO_LARGE/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2 * 1024 * 1024);
});

test("MCP validates its advertised schema before invoking even an injected bridge", async (t) => {
    let calls = 0;
    const server = createMcpServer({ async readSession() { calls++; return { accepted: true }; } });
    const client = new Client({ name: "schema-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    t.after(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const valid = { provider: "codex", projectPath: process.cwd(), sessionId: "valid-id" };
    for (const args of [
        { ...valid, provider: "bad" }, { ...valid, projectPath: "." },
        { ...valid, sessionId: "../bad" }, { ...valid, sessionId: "bad\u0000id" },
        { ...valid, maxChars: 1 }, { ...valid, extra: true }, {}
    ]) {
        const result = await client.callTool({ name: "read_session", arguments: args });
        assert.equal(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).code, "INVALID_ARGUMENT");
    }
    assert.equal(calls, 0);
    const accepted = await client.callTool({ name: "read_session", arguments: valid });
    assert.equal(accepted.isError, undefined);
    assert.equal(calls, 1);
});
