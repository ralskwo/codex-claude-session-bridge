const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const fixture = path.join(__dirname, "fixtures", "claude-reader-child.js");

test.before(async () => {
    const packagePath = path.join(path.dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json");
    assert.equal(JSON.parse(await fs.readFile(packagePath, "utf8")).version, "0.3.263");
});

for (const scenario of ["compacted", "malformed-small"]) {
    test(`official Claude SDK ${scenario} history is unknown and source bytes stay unchanged`, async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-sdk-source-"));
        try {
            const projectPath = path.join(root, "workspace");
            const configDir = path.join(root, "claude");
            const sessionId = "11111111-1111-4111-8111-111111111111";
            const sessionDir = path.join(configDir, "projects", "synthetic-project");
            await fs.mkdir(projectPath);
            await fs.mkdir(sessionDir, { recursive: true });
            const common = { sessionId, cwd: projectPath, timestamp: "2026-09-06T00:00:00.000Z" };
            const old = { type: "user", ...common, uuid: "old", parentUuid: null, message: { role: "user", content: "old-visible" } };
            const padding = { type: "attachment", ...common, uuid: "pad", parentUuid: "old", attachment: { data: "x".repeat(6 * 1024 * 1024) } };
            const boundary = { type: "system", subtype: "compact_boundary", ...common, uuid: "boundary", parentUuid: "pad", compactMetadata: { trigger: "auto" } };
            const latest = { type: "user", ...common, uuid: "new", parentUuid: "boundary", message: { role: "user", content: "new-visible" } };
            const answer = { type: "assistant", ...common, uuid: "answer", parentUuid: scenario === "compacted" ? "new" : "old", message: { role: "assistant", content: [{ type: "text", text: "answer-visible" }] } };
            const transcript = scenario === "compacted"
                ? [old, padding, boundary, latest, answer].map((row) => JSON.stringify(row)).join("\n") + "\n"
                : JSON.stringify(old) + "\n{invalid-transcript-row\n" + JSON.stringify(answer) + "\n";
            const files = [path.join(sessionDir, sessionId + ".jsonl"), path.join(configDir, ".credentials.json"), path.join(configDir, "settings.json")];
            await fs.writeFile(files[0], transcript);
            await fs.writeFile(files[1], JSON.stringify({ synthetic: "credentials-preserved" }));
            await fs.writeFile(files[2], JSON.stringify({ synthetic: "settings-preserved" }));
            const before = await Promise.all(files.map((file) => fs.readFile(file)));
            const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PROJECT_DIR_NAME: "synthetic-project" };
            delete env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP;
            const { stdout, stderr } = await execFileAsync(process.execPath, [fixture, projectPath, sessionId], { env, timeout: 15000, windowsHide: true, shell: false, maxBuffer: 65536 });
            assert.equal(stderr, "");
            const result = JSON.parse(stdout);
            assert.equal(result.sdkCount, 2);
            assert.equal(result.sdkHasOld, scenario !== "compacted");
            assert.equal(result.providerCount, 2);
            assert.equal(result.providerHistoryComplete, false);
            assert.ok(result.providerWarnings.includes("SDK_RECONSTRUCTED"));
            assert.equal(result.publicHistoryComplete, false);
            assert.equal(result.publicOmittedMessages, null);
            assert.equal(result.publicTruncated, true);
            assert.ok(result.publicWarnings.some((warning) => warning.includes("SDK")));
            const after = await Promise.all(files.map((file) => fs.readFile(file)));
            for (let index = 0; index < files.length; index++) { assert.deepEqual(after[index], before[index]); }
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
}
