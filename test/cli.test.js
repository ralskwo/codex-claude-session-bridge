const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { runCli } = require("../src/cli.js");

function capture() {
    let stdout = "";
    let stderr = "";
    return { stdout: { write(value) { stdout += value; } },
        stderr: { write(value) { stderr += value; } },
        output: () => stdout, error: () => stderr };
}

test("CLI maps typed flags into the selected bridge method", async () => {
    const io = capture();
    let received;
    const code = await runCli(["handoff", "--provider", "claude", "--project", "C:/demo",
        "--session", "fixture", "--max-messages", "10", "--max-chars", "5000"], {
        async prepareHandoff(args) { received = args; return { context: "합성 맥락" }; }
    }, io);
    assert.equal(code, 0);
    assert.deepEqual(received, { provider: "claude", projectPath: "C:/demo", sessionId: "fixture",
        maxMessages: 10, maxChars: 5000 });
    assert.deepEqual(JSON.parse(io.output()), { context: "합성 맥락" });
    assert.equal(io.error(), "");
});

test("CLI rejects unknown, duplicate, missing and noninteger options before calling providers", async () => {
    let calls = 0;
    const bridge = { async listSessions() { calls++; } };
    for (const argv of [["list", "--mystery", "x"], ["list", "--limit", "2.2"],
        ["list", "--limit", "3", "--limit", "4"], ["list", "--project"], ["execute"]]) {
        const io = capture();
        assert.equal(await runCli(argv, bridge, io), 1);
        assert.equal(io.output(), "");
        assert.equal(JSON.parse(io.error()).code, "INVALID_ARGUMENT");
    }
    assert.equal(calls, 0);
});

test("CLI serializes a bounded safe error instead of oversized or secret provider output", async () => {
    for (const method of [async () => ({ value: "x".repeat(3 * 1024 * 1024) }),
        async () => { throw new Error("PRIVATE-UPSTREAM-CREDENTIAL"); }]) {
        const io = capture();
        assert.equal(await runCli(["list"], { listSessions: method }, io), 1);
        assert.equal(io.output(), "");
        assert.equal(io.error().includes("PRIVATE-UPSTREAM-CREDENTIAL"), false);
        assert.ok(Buffer.byteLength(io.error()) < 2000);
    }
});

test("actual CLI process exits with failure for an unsupported operation", () => {
    const result = spawnSync(process.execPath, [path.join(__dirname, "../src/cli.js"), "execute"],
        { encoding: "utf8", windowsHide: true, timeout: 10000 });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.ok(result.stderr);
});
