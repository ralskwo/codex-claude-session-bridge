const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createBridge } = require("../src/bridge.js");

async function fixture(t, overrides = {}) {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-test-"));
    t.after(() => fs.rm(projectPath, { recursive: true, force: true }));
    const provider = {
        async list() { return { sessions: [{ sessionId: "session-1", projectPath, title: "title", updatedAt: 123 }], nextOffset: null, warnings: [] }; },
        async read() { return { sessionId: "session-1", projectPath, messages: [{ role: "user", text: "old" }, { role: "assistant", text: "sk-ant-test-secret-value" }, { role: "user", text: "new" }], historyComplete: true, warnings: [] }; },
        ...overrides,
    };
    return { projectPath, provider, bridge: createBridge({ codex: provider, claude: provider }) };
}

for (const providerName of ["codex", "claude"]) {
    test(`${providerName} list/read/handoff returns normalized same-project bounded context`, async (t) => {
        const { projectPath, bridge } = await fixture(t);
        const options = { provider: providerName, projectPath, sessionId: "session-1" };
        const list = await bridge.listSessions({ provider: providerName, projectPath });
        assert.equal(list.sessions[0].provider, providerName);
        assert.equal(list.sessions[0].updatedAt, 123);
        const read = await bridge.readSession({ ...options, maxMessages: 2 });
        assert.deepEqual(read.messages, [{ role: "assistant", text: "[REDACTED]" }, { role: "user", text: "new" }]);
        assert.equal(read.omittedMessages, 1);
        const handoff = await bridge.prepareHandoff({ ...options, maxMessages: 2 });
        assert.ok(handoff.context.includes("참고자료"));
        assert.equal(handoff.context.includes("sk-ant-test-secret-value"), false);
    });
}

test("read rejects foreign, missing, deleted cwd and mismatched session IDs", async (t) => {
    const { projectPath, bridge, provider } = await fixture(t);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-other-"));
    t.after(() => fs.rm(other, { recursive: true, force: true }));
    for (const returned of [other, undefined, path.join(projectPath, "deleted")]) {
        provider.read = async () => ({ sessionId: "session-1", projectPath: returned, messages: [{ role: "user", text: "private" }], historyComplete: true });
        await assert.rejects(bridge.readSession({ provider: "codex", projectPath, sessionId: "session-1" }), /프로젝트/);
    }
    provider.read = async () => ({ sessionId: "different", projectPath, messages: [], historyComplete: true });
    await assert.rejects(bridge.readSession({ provider: "codex", projectPath, sessionId: "session-1" }), { code: "INVALID_METADATA" });
});

test("public inputs reject invalid options before calling provider", async (t) => {
    const { bridge, projectPath } = await fixture(t, { async list() { throw new Error("must not call"); }, async read() { throw new Error("must not call"); } });
    const valid = { provider: "codex", projectPath, sessionId: "session-1" };
    for (const options of [null, [], "bad", Object.create(valid), { ...valid, extra: true }, { ...valid, provider: "other" }, { ...valid, sessionId: "" }, { ...valid, sessionId: "../x" }, { ...valid, sessionId: "a\\b" }, { ...valid, sessionId: "a\nb" }, { ...valid, sessionId: "x".repeat(201) }, { ...valid, maxMessages: 0 }, { ...valid, maxMessages: 201 }, { ...valid, maxChars: 999 }, { ...valid, maxChars: 100001 }, { ...valid, maxChars: 1000.5 }]) {
        await assert.rejects(bridge.readSession(options), { code: "INVALID_ARGUMENT" });
    }
    for (const options of [{ provider: "codex", projectPath, limit: 0 }, { provider: "codex", projectPath, offset: -1 }, { provider: "codex", projectPath, offset: 10001 }, { provider: "codex", projectPath, limit: 101 }, { provider: "codex", projectPath, limit: 1.5 }]) {
        await assert.rejects(bridge.listSessions(options), { code: "INVALID_ARGUMENT" });
    }
    await assert.rejects(bridge.listSessions({ provider: "codex", projectPath: "." }), { code: "INVALID_PROJECT" });
    await assert.rejects(bridge.listSessions({ provider: "codex" }), { code: "INVALID_PROJECT" });
});

test("list forwards pagination and rejects invalid rows while redacting and bounding metadata", async (t) => {
    const { bridge, projectPath, provider } = await fixture(t);
    provider.list = async (args) => {
        assert.equal(args.offset, 20);
        assert.equal(args.limit, 2);
        return { sessions: [
            { sessionId: "session-1", projectPath, title: "sk-ant-title-secret " + "x".repeat(500), updatedAt: 50, extra: "private" },
            { sessionId: "session-2", title: "missing cwd", updatedAt: 1 },
        ], nextOffset: 22, warnings: ["STATE_DB_ONLY", "password=upstream-secret", ...Array(30).fill("IN_PROGRESS")] };
    };
    const result = await bridge.listSessions({ provider: "codex", projectPath, offset: 20, limit: 2 });
    assert.equal(result.nextOffset, 22);
    assert.equal(result.sessions.length, 1);
    assert.ok(result.sessions[0].title.length <= 200);
    assert.equal(JSON.stringify(result).includes("sk-ant-title-secret"), false);
    assert.equal(JSON.stringify(result).includes("upstream-secret"), false);
    assert.equal(Object.hasOwn(result.sessions[0], "extra"), false);
    assert.ok(result.warnings.length <= 20);
    assert.ok(result.warnings.every((warning) => typeof warning === "string" && warning.length <= 160));
});

test("read excludes hidden roles and fields and reports incomplete history", async (t) => {
    const { bridge, projectPath, provider } = await fixture(t);
    provider.read = async () => ({ sessionId: "session-1", projectPath, messages: [{ role: "assistant", text: "visible", thinking: "private" }, { role: "system", text: "secret" }, { role: "tool", text: "private tool" }], historyComplete: false, warnings: ["HISTORY_LIMIT", "raw private warning"] });
    const result = await bridge.readSession({ provider: "claude", projectPath, sessionId: "session-1" });
    assert.deepEqual(result.messages, [{ role: "assistant", text: "visible" }]);
    assert.equal(result.omittedMessages, null);
    assert.equal(result.truncated, true);
    assert.equal(JSON.stringify(result).includes("private"), false);
});

test("upstream error messages never escape bridge", async (t) => {
    const { bridge, projectPath } = await fixture(t, { async read() { const error = new Error("password=secret-value"); error.code = "RPC_ERROR"; throw error; } });
    await assert.rejects(bridge.readSession({ provider: "claude", projectPath, sessionId: "session-1" }), (error) => error.code === "PROVIDER_ERROR" && !error.message.includes("secret-value"));
});

test("list validates timestamps, IDs, pagination and duplicate order", async (t) => {
    const { bridge, projectPath, provider } = await fixture(t);
    provider.list = async () => ({ sessions: [
        { sessionId: "b", projectPath, title: "b", updatedAt: 5 },
        { sessionId: "a", projectPath, title: "a", updatedAt: 5 },
        { sessionId: "b", projectPath, title: "duplicate", updatedAt: 4 },
        { sessionId: "../bad", projectPath, title: "invalid ID", updatedAt: 2 },
        { sessionId: "invalid", projectPath, title: "bad timestamp", updatedAt: "today" },
    ], nextOffset: null, warnings: [] });
    const result = await bridge.listSessions({ provider: "codex", projectPath });
    assert.deepEqual(result.sessions.map((session) => session.sessionId), ["a", "b"]);
    for (const nextOffset of [undefined, "1", -1, 0, 10001]) {
        provider.list = async () => ({ sessions: [], nextOffset });
        await assert.rejects(bridge.listSessions({ provider: "codex", projectPath }), { code: "INVALID_METADATA" });
    }
});

test("public options reject getters and symbol keys without executing getters", async (t) => {
    const { bridge, projectPath } = await fixture(t);
    const options = { provider: "codex", projectPath };
    Object.defineProperty(options, "limit", { get() { throw new Error("getter executed"); } });
    await assert.rejects(bridge.listSessions(options), { code: "INVALID_ARGUMENT" });
    await assert.rejects(bridge.listSessions({ provider: "codex", projectPath, [Symbol("extra")]: true }), { code: "INVALID_ARGUMENT" });
});

test("read rejects malformed metadata and hidden content never appears in handoff", async (t) => {
    const { bridge, projectPath, provider } = await fixture(t);
    for (const historyComplete of [undefined, null, "true"]) {
        provider.read = async () => ({ sessionId: "session-1", projectPath, messages: [], historyComplete });
        await assert.rejects(bridge.readSession({ provider: "codex", projectPath, sessionId: "session-1" }), { code: "INVALID_METADATA" });
    }
    provider.read = async () => ({ sessionId: "session-1", projectPath, messages: [{ role: "assistant", text: "visible", reasoning: "secret reasoning" }, { role: "developer", text: "secret directive" }], historyComplete: true, warnings: ["IN_PROGRESS"] });
    const result = await bridge.prepareHandoff({ provider: "codex", projectPath, sessionId: "session-1" });
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.ok(result.warnings.some((warning) => warning.startsWith("IN_PROGRESS:")));
    assert.ok(result.warnings.some((warning) => warning.startsWith("EXCLUDED_CONTENT:")));
});
