const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { RpcClient } = require("../src/providers/rpc");
const { createCodexProvider, resolveCodexCommand } = require("../src/providers/codex");
const { createClaudeProvider } = require("../src/providers/claude");
const { canonicalProject } = require("../src/project");
const fixture = path.join(__dirname, "fixtures", "rpc-child.js");
let projectPath;
let otherPath;
test.before(async () => {
    projectPath = await canonicalProject(await fs.mkdtemp(path.join(os.tmpdir(), "bridge-provider-")));
    otherPath = await canonicalProject(await fs.mkdtemp(path.join(os.tmpdir(), "bridge-other-")));
});
test.after(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
    await fs.rm(otherPath, { recursive: true, force: true });
});

test("RPC split chunks and notifications preserve request ID matching", async () => {
    const rpc = new RpcClient({ command: process.execPath, args: [fixture, "split"], timeoutMs: 1000 });
    const results = await Promise.all([rpc.request("initialize", {}), rpc.request("thread/list", {})]);
    assert.deepEqual(results.map((result) => result.method), ["initialize", "thread/list"]);
    await rpc.close();
    assert.equal(rpc.closed, true);
    assert.ok(rpc.child.exitCode !== null || rpc.child.signalCode !== null);
});

for (const mode of ["hang", "eof", "oversized", "malformed", "error"]) {
    test(`RPC ${mode} rejects safely and cleans pending requests`, async () => {
        const rpc = new RpcClient({ command: process.execPath, args: [fixture, mode], timeoutMs: 200, maxResponseBytes: 1024 });
        await assert.rejects(rpc.request("initialize", {}), (error) => {
            assert.doesNotMatch(error.message, /secret-token-hidden/);
            return true;
        });
        await rpc.close();
        assert.equal(rpc.closed, true);
        assert.ok(rpc.child.exitCode !== null || rpc.child.signalCode !== null);
    });
}

test("RPC blocks mutating methods before writing", async () => {
    const rpc = new RpcClient({ command: process.execPath, args: [fixture, "split"] });
    await assert.rejects(rpc.request("turn/start", {}), /허용/);
    await rpc.close();
});

function codex(handler) {
    const calls = [];
    let closed = 0;
    const provider = createCodexProvider({ rpcFactory: async () => ({
        request: async (method, params) => {
            calls.push({ method, params });
            return method === "initialize" ? { codexHome: projectPath } : handler(method, params);
        },
        notify: (method) => calls.push({ method }),
        close: async () => { closed++; },
    }) });
    return { provider, calls, get closed() { return closed; } };
}

function thread(overrides = {}) {
    return { id: "session-a", cwd: projectPath, updatedAt: 1000, name: "제목", ...overrides };
}
function turns() {
    return [{ id: "t1", status: "completed", items: [
        { id: "i1", type: "userMessage", content: [{ type: "text", text: "질문" }] },
        { id: "i2", type: "agentMessage", text: "답변" },
        { id: "private", type: "reasoning", text: "숨김" },
    ] }];
}

test("Codex lists all source kinds with DB-only pages, scope/dedup/order/pagination", async () => {
    const source = codex((method, params) => {
        assert.equal(method, "thread/list");
        assert.equal(params.useStateDbOnly, true);
        assert.equal(params.cwd, projectPath);
        assert.equal(params.archived, false);
        assert.equal(params.sortDirection, "desc");
        assert.ok(params.sourceKinds.includes("appServer"));
        assert.ok(params.sourceKinds.includes("exec"));
        return params.cursor ? { data: [thread({ id: "exec", source: "exec", updatedAt: 3000 })], nextCursor: null }
            : { data: [thread(), thread(), thread({ id: "child", parentThreadId: "a" }), thread({ id: "other", cwd: otherPath }), thread({ id: "app", source: "appServer", updatedAt: 2000 })], nextCursor: "next" };
    });
    const result = await source.provider.list({ projectPath, limit: 2, offset: 0 });
    assert.deepEqual(result.sessions.map((session) => session.sessionId), ["exec", "app"]);
    assert.equal(result.sessions[0].updatedAt, 3000000);
    assert.equal(result.nextOffset, 2);
    assert.ok(result.warnings.includes("STATE_DB_ONLY"));
    assert.equal(source.calls[0].params.capabilities.experimentalApi, true);
    assert.equal(source.calls[1].method, "initialized");
    assert.equal(source.closed, 1);
});

test("Codex legacy/paginated messages match and page mode never requests includeTurns true", async () => {
    const results = [];
    for (const mode of ["legacy", "paginated", undefined]) {
        const source = codex((method, params) => {
            if (method === "thread/read") {
                if (mode === "paginated") { assert.equal(params.includeTurns, false); }
                return { thread: thread({ historyMode: mode, turns: params.includeTurns ? turns() : [] }) };
            }
            assert.equal(params.itemsView, "full");
            assert.equal(params.limit, 50);
            return { data: turns(), nextCursor: null };
        });
        const result = await source.provider.read({ projectPath, sessionId: "session-a" });
        assert.equal(result.historyComplete, true);
        results.push(result.messages);
        assert.equal(source.closed, 1);
    }
    assert.deepEqual(results[0], [{ role: "user", text: "질문" }, { role: "assistant", text: "답변" }]);
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
});

test("Codex rejects mismatched metadata before any body request", async () => {
    for (const invalid of [{ cwd: otherPath }, { id: "wrong" }, { cwd: undefined }, { cwd: path.join(projectPath, "deleted") }]) {
        const source = codex(() => ({ thread: thread(invalid) }));
        await assert.rejects(source.provider.read({ projectPath, sessionId: "session-a" }));
        assert.equal(source.calls.filter((call) => call.method === "thread/read").length, 1);
        assert.equal(source.calls.some((call) => call.method === "thread/turns/list"), false);
        assert.equal(source.closed, 1);
    }
});

test("Codex repeated cursor, duplicate items and in-progress partial items mark incomplete", async () => {
    const source = codex((method) => method === "thread/read"
        ? { thread: thread({ historyMode: "paginated" }) }
        : { data: [{ ...turns()[0], status: "inProgress", items: [...turns()[0].items, { id: "bad", type: "agentMessage" }] }], nextCursor: "repeat" });
    const result = await source.provider.read({ projectPath, sessionId: "session-a" });
    assert.equal(result.historyComplete, false);
    assert.equal(result.messages.length, 2);
    assert.ok(result.warnings.includes("REPEATED_CURSOR"));
    assert.ok(result.warnings.includes("IN_PROGRESS"));
    assert.ok(result.warnings.includes("INCOMPLETE_ITEMS"));
});

test("Codex newest 200 messages survive history cap", async () => {
    const data = Array.from({ length: 150 }, (_, index) => ({ id: `t${index}`, status: "completed", items: [
        { id: `u${index}`, type: "userMessage", content: [{ type: "text", text: `u${index}` }] },
        { id: `a${index}`, type: "agentMessage", text: `a${index}` },
    ] }));
    const source = codex((method) => method === "thread/read" ? { thread: thread({ historyMode: "paginated" }) } : { data: [...data].reverse(), nextCursor: "more" });
    const result = await source.provider.read({ projectPath, sessionId: "session-a" });
    assert.equal(result.messages.length, 200);
    assert.equal(result.messages[0].text, "u50");
    assert.equal(result.messages.at(-1).text, "a149");
    assert.equal(result.historyComplete, false);
});

test("Codex invalid init and read errors are redacted and child closes", async () => {
    let closed = 0;
    const badInit = createCodexProvider({ rpcFactory: async () => ({ request: async () => null, close: async () => { closed++; } }) });
    await assert.rejects(badInit.list({ projectPath }), /초기화/);
    assert.equal(closed, 1);
    const source = codex(() => { throw new Error("secret-token-hidden"); });
    await assert.rejects(source.provider.read({ projectPath, sessionId: "session-a" }), (error) => !error.message.includes("secret-token-hidden"));
    assert.equal(source.closed, 1);
});

test("Codex rejects empty init and unknown history modes", async () => {
    const bad = createCodexProvider({ rpcFactory: async () => ({ request: async () => ({}), notify: () => {}, close: async () => {} }) });
    await assert.rejects(bad.list({ projectPath }), /초기화/);
    const source = codex(() => ({ thread: thread({ historyMode: "future" }) }));
    await assert.rejects(source.provider.read({ projectPath, sessionId: "session-a" }), /지원되지/);
    assert.equal(source.calls.filter((call) => call.method === "thread/read").length, 1);
});

test("provider errors with forged known code cannot leak upstream text", async () => {
    const error = new Error("secret-token-hidden");
    error.code = "SESSION_TOO_LARGE";
    const provider = createClaudeProvider({ sdk: claudeSdk({ getSessionInfo: async () => { throw error; } }) });
    await assert.rejects(provider.read({ projectPath, sessionId: "session-a" }), (err) => !err.message.includes("secret-token-hidden"));
});

test("Codex incomplete text blocks and duplicate pages mark history incomplete", async () => {
    let pages = 0;
    const source = codex((method) => {
        if (method === "thread/read") { return { thread: thread({ historyMode: "paginated" }) }; }
        pages++;
        return { data: [{ id: "t1", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text" }] }, ...turns()[0].items] }], nextCursor: pages === 1 ? "next" : null };
    });
    const result = await source.provider.read({ projectPath, sessionId: "session-a" });
    assert.equal(result.historyComplete, false);
    assert.ok(result.warnings.includes("INCOMPLETE_ITEMS"));
    assert.ok(result.warnings.includes("DUPLICATE_ITEMS"));
});

test("Codex page scan stops at 100 pages and 1000 turns", async () => {
    let listCalls = 0;
    const listSource = codex(() => ({ data: [], nextCursor: `c${++listCalls}` }));
    assert.ok((await listSource.provider.list({ projectPath })).warnings.includes("SCAN_LIMIT"));
    assert.equal(listCalls, 100);
    let turnCalls = 0;
    const source = codex((method) => method === "thread/read" ? { thread: thread({ historyMode: "paginated" }) }
        : { data: Array.from({ length: 50 }, (_, i) => ({ id: `t${turnCalls}-${i}`, status: "completed", items: [] })), nextCursor: `c${++turnCalls}` });
    const result = await source.provider.read({ projectPath, sessionId: "session-a" });
    assert.equal(turnCalls, 20);
    assert.equal(result.historyComplete, false);
});

test("providers reject relative project paths without opening sources", async () => {
    let calls = 0;
    const provider = createClaudeProvider({ sdk: claudeSdk({ listSessions: async () => { calls++; return []; } }) });
    await assert.rejects(provider.list({ projectPath: "." }));
    const source = codex(() => { calls++; });
    await assert.rejects(source.provider.read({ projectPath: ".", sessionId: "a" }));
    assert.equal(calls, 0);
    assert.equal(source.closed, 0);
});

function claudeSdk(overrides = {}) {
    return {
        listSessions: async () => [{ sessionId: "session-a", cwd: projectPath, lastModified: 1234, summary: "제목", fileSize: 100 }],
        getSessionInfo: async () => ({ sessionId: "session-a", cwd: projectPath, fileSize: 100 }),
        getSessionMessages: async () => [{ session_id: "session-a", type: "user", message: { role: "user", content: [{ type: "text", text: "질문" }, { type: "image", source: "private" }] } },
            { session_id: "session-a", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "답변" }] } }],
        ...overrides,
    };
}

test("Claude official readers use exact scope and select only display text", async () => {
    const sdk = claudeSdk({ listSessions: async (options) => {
        assert.equal(options.dir, projectPath);
        assert.equal(options.includeWorktrees, false);
        assert.equal(options.includeProgrammatic, true);
        return [thread({ sessionId: "session-a", lastModified: 1234 })];
    } });
    const provider = createClaudeProvider({ sdk });
    assert.equal((await provider.list({ projectPath })).sessions.length, 1);
    const result = await provider.read({ projectPath, sessionId: "session-a" });
    assert.deepEqual(result.messages, [{ role: "user", text: "질문" }, { role: "assistant", text: "답변" }]);
    assert.equal(result.historyComplete, false);
    assert.ok(result.warnings.includes("SDK_RECONSTRUCTED"));
});

test("Claude rejects invalid metadata and oversized file before body reader", async () => {
    for (const invalid of [{ cwd: otherPath }, { sessionId: "wrong" }, { cwd: undefined }, { fileSize: 64 * 1024 * 1024 + 1 }]) {
        let reads = 0;
        const provider = createClaudeProvider({ sdk: claudeSdk({ getSessionInfo: async () => ({ sessionId: "session-a", cwd: projectPath, fileSize: 100, ...invalid }), getSessionMessages: async () => { reads++; return []; } }) });
        await assert.rejects(provider.read({ projectPath, sessionId: "session-a" }));
        assert.equal(reads, 0);
    }
});

test("Claude API absence, mismatched message ID and reader errors fail safely", async () => {
    await assert.rejects(createClaudeProvider({ sdk: {} }).read({ projectPath, sessionId: "a" }), /지원되지 않는 Claude SDK 읽기 API/);
    const mismatch = createClaudeProvider({ sdk: claudeSdk({ getSessionMessages: async () => [{ type: "user", session_id: "wrong", message: { content: "private" } }] }) });
    await assert.rejects(mismatch.read({ projectPath, sessionId: "session-a" }));
    const error = createClaudeProvider({ sdk: claudeSdk({ getSessionInfo: async () => { throw new Error("secret-token-hidden"); } }) });
    await assert.rejects(error.read({ projectPath, sessionId: "session-a" }), (err) => !err.message.includes("secret-token-hidden"));
});

test("Claude enforces returned text size limit", async () => {
    const provider = createClaudeProvider({ sdk: claudeSdk({ getSessionMessages: async () => [{ type: "user", session_id: "session-a", message: { content: "a".repeat(32 * 1024 * 1024 + 1) } }] }) });
    await assert.rejects(provider.read({ projectPath, sessionId: "session-a" }), /크기/);
});

test("explicit executable and source home are used without command shell", async () => {
    const result = await resolveCodexCommand({ executable: process.execPath, codexHome: projectPath });
    assert.equal(result.command, process.execPath);
    assert.deepEqual(result.args, ["app-server", "--stdio"]);
    assert.equal(result.env.CODEX_HOME, projectPath);
    await assert.rejects(resolveCodexCommand({ executable: "C:\\bad.cmd" }), /실행/);
});

test("environment executable and source home override desktop discovery", async () => {
    const result = await resolveCodexCommand({ env: { SESSION_BRIDGE_CODEX_EXECUTABLE: process.execPath, SESSION_BRIDGE_CODEX_HOME: projectPath, CODEX_HOME: otherPath } });
    assert.equal(result.command, process.execPath);
    assert.equal(result.env.CODEX_HOME, projectPath);
});

test("Windows Desktop discovery chooses highest verified version before PATH", { skip: process.platform !== "win32" }, async () => {
    const desktop = path.join(projectPath, "OpenAI", "Codex", "bin");
    for (const name of ["old", "new", "broken"]) {
        await fs.mkdir(path.join(desktop, name), { recursive: true });
        await fs.writeFile(path.join(desktop, name, "codex.exe"), "synthetic");
    }
    const result = await resolveCodexCommand({ env: { LOCALAPPDATA: projectPath, PATH: "", SESSION_BRIDGE_CODEX_EXECUTABLE: "", CODEX_HOME: "", SESSION_BRIDGE_CODEX_HOME: "" }, versionProbe: async (exe) => {
        if (exe.includes("broken")) { throw new Error(); }
        return exe.includes("new") ? [0, 153, 0] : [0, 145, 0];
    } });
    assert.equal(result.command.toLowerCase(), path.join(desktop, "new", "codex.exe").toLowerCase());
});

test("Codex validates initialized source home before reading metadata", async () => {
    let bodyCalls = 0;
    const provider = createCodexProvider({ codexHome: otherPath, rpcFactory: async () => ({
        request: async (method) => {
            if (method !== "initialize") { bodyCalls++; }
            return { codexHome: projectPath };
        }, notify: () => {}, close: async () => {},
    }) });
    await assert.rejects(provider.read({ projectPath, sessionId: "session-a" }));
    assert.equal(bodyCalls, 0);
});

test("Claude missing file size is rejected and incomplete text is signaled", async () => {
    let reads = 0;
    const missing = createClaudeProvider({ sdk: claudeSdk({ getSessionInfo: async () => ({ sessionId: "session-a", cwd: projectPath }), getSessionMessages: async () => { reads++; return []; } }) });
    await assert.rejects(missing.read({ projectPath, sessionId: "session-a" }), /크기/);
    assert.equal(reads, 0);
    const malformed = createClaudeProvider({ sdk: claudeSdk({ getSessionMessages: async () => [{ type: "user", session_id: "session-a", message: { content: [{ type: "text" }] } }] }) });
    const result = await malformed.read({ projectPath, sessionId: "session-a" });
    assert.equal(result.historyComplete, false);
    assert.ok(result.warnings.includes("INCOMPLETE_ITEMS"));
});

test("synthetic source transcript/auth/config are unchanged after provider reads", async () => {
    const files = ["transcript.jsonl", "auth.json", "config.toml"];
    for (const name of files) { await fs.writeFile(path.join(projectPath, name), `synthetic-${name}`); }
    const before = await Promise.all(files.map((name) => fs.readFile(path.join(projectPath, name), "utf8")));
    await createClaudeProvider({ sdk: claudeSdk() }).read({ projectPath, sessionId: "session-a" });
    const source = codex((method, params) => ({ thread: thread({ turns: params.includeTurns ? turns() : [] }) }));
    await source.provider.read({ projectPath, sessionId: "session-a" });
    const after = await Promise.all(files.map((name) => fs.readFile(path.join(projectPath, name), "utf8")));
    assert.deepEqual(after, before);
});
