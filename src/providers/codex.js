const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { RpcClient, providerError } = require("./rpc");
const { canonicalProject, assertSameProject, validateSessionId, validatePage, filterSessions, pageSessions, redactFailure } = require("./common");

const execFileAsync = promisify(execFile);
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"];

async function executableLaunch(executable) {
    if (typeof executable !== "string" || !path.isAbsolute(executable) || /\.(cmd|bat|ps1)$/i.test(executable)) {
        throw providerError("EXECUTABLE_NOT_FOUND", "Codex 실행 파일의 절대 경로를 지정해주세요. 셸 런처는 지원하지 않습니다.");
    }
    const actual = await fs.realpath(executable);
    if (/\.(cmd|bat|ps1)$/i.test(actual)) { throw new Error(); }
    if (!(await fs.stat(actual)).isFile()) { throw new Error(); }
    if (/\.[cm]?js$/i.test(actual)) {
        const root = path.dirname(path.dirname(actual));
        const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
        const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.codex;
        if (pkg.name !== "@openai/codex" || !bin || path.resolve(root, bin) !== actual) { throw new Error(); }
        return { command: process.execPath, args: [actual, "app-server", "--stdio"] };
    }
    return { command: actual, args: ["app-server", "--stdio"] };
}

async function engineVersion(executable) {
    const { stdout } = await execFileAsync(executable, ["--version"], { windowsHide: true, shell: false, timeout: 3000, maxBuffer: 4096 });
    const match = stdout.match(/codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/i);
    if (!match) { throw new Error(); }
    return match.slice(1).map(Number);
}

async function resolveCodexCommand(options = {}) {
    const env = { ...process.env, ...options.env };
    const codexHome = options.codexHome || env.SESSION_BRIDGE_CODEX_HOME || env.CODEX_HOME;
    if (codexHome) { env.CODEX_HOME = await canonicalProject(codexHome); }
    const explicit = options.executable || env.SESSION_BRIDGE_CODEX_EXECUTABLE;
    try {
        if (explicit) { return { ...await executableLaunch(explicit), env }; }
        if (process.platform === "win32") {
            const local = env.LOCALAPPDATA || (env.USERPROFILE && path.join(env.USERPROFILE, "AppData", "Local"));
            if (local) {
                const bin = path.join(local, "OpenAI", "Codex", "bin");
                const candidates = [];
                for (const entry of await fs.readdir(bin, { withFileTypes: true }).catch(() => [])) {
                    if (!entry.isDirectory()) { continue; }
                    const executable = path.join(bin, entry.name, "codex.exe");
                    try { candidates.push({ executable, version: await (options.versionProbe || engineVersion)(executable) }); } catch { /* 다른 설치 잔여물은 제외한다. */ }
                }
                candidates.sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2]);
                if (candidates.length) { return { ...await executableLaunch(candidates[0].executable), env }; }
            }
        }
        const directories = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
        for (const directory of directories) {
            const native = path.join(directory, process.platform === "win32" ? "codex.exe" : "codex");
            try { return { ...await executableLaunch(native), env }; } catch { /* 다음 PATH 후보를 검사한다. */ }
        }
        for (const directory of directories) {
            const launcher = path.join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
            try { return { ...await executableLaunch(launcher), env }; } catch { /* 검증된 npm 런처만 허용한다. */ }
        }
    } catch {
        throw providerError("EXECUTABLE_NOT_FOUND", "Codex 실행 파일을 확인하지 못했습니다. SESSION_BRIDGE_CODEX_EXECUTABLE을 확인해주세요.");
    }
    throw providerError("EXECUTABLE_NOT_FOUND", "Codex 실행 파일을 찾지 못했습니다. SESSION_BRIDGE_CODEX_EXECUTABLE을 지정해주세요.");
}

function timestamp(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) { return NaN; }
    return Math.trunc(value < 100000000000 ? value * 1000 : value);
}

function createCodexProvider(options = {}) {
    async function withRpc(action) {
        let rpc;
        try {
            const launch = options.rpcFactory ? null : await resolveCodexCommand(options);
            rpc = options.rpcFactory ? await options.rpcFactory() : new RpcClient({ ...launch, timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes });
            const init = await rpc.request("initialize", { clientInfo: { name: "session_bridge", version: "0.1.0" }, capabilities: { experimentalApi: true } });
            if (!init || typeof init.codexHome !== "string" || !path.isAbsolute(init.codexHome)) { throw providerError("CODEX_INIT", "Codex 초기화 응답을 확인하지 못했습니다."); }
            const expectedHome = options.codexHome || launch?.env.CODEX_HOME;
            if (expectedHome) { await assertSameProject(init.codexHome, expectedHome); }
            rpc.notify("initialized", {});
            return await action(rpc);
        } catch (error) {
            throw redactFailure(error, "Codex");
        } finally {
            if (rpc) { await rpc.close(); }
        }
    }

    async function validateThread(thread, sessionId, project) {
        if (!thread || thread.id !== sessionId) { throw providerError("SESSION_MISMATCH", "세션 ID가 일치하지 않습니다."); }
        await assertSameProject(thread.cwd, project);
    }

    return {
        async list({ projectPath, limit = 20, offset = 0 }) {
            const project = await canonicalProject(projectPath);
            const page = validatePage(limit, offset);
            return withRpc(async (rpc) => {
                const rows = [];
                const cursors = new Set();
                const warnings = new Set(["STATE_DB_ONLY"]);
                let cursor;
                for (let count = 0; count < 100; count++) {
                    const result = await rpc.request("thread/list", { cwd: project, limit: 100, archived: false, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true, sourceKinds: [...SOURCE_KINDS], ...(cursor ? { cursor } : {}) });
                    if (!Array.isArray(result?.data)) { throw new Error(); }
                    rows.push(...result.data.slice(0, 10000 - rows.length));
                    if (!result.nextCursor) { break; }
                    if (cursors.has(result.nextCursor)) { warnings.add("REPEATED_CURSOR"); break; }
                    cursors.add(result.nextCursor);
                    cursor = result.nextCursor;
                    if (rows.length >= 10000 || count === 99) { warnings.add("SCAN_LIMIT"); break; }
                }
                const sessions = await filterSessions(rows.filter((row) => row && row.parentThreadId == null).map((row) => ({ sessionId: row.id, projectPath: row.cwd, title: row.name || row.preview || "", updatedAt: timestamp(row.updatedAt) })), project);
                return pageSessions(sessions, page, warnings);
            });
        },

        async read({ projectPath, sessionId }) {
            const project = await canonicalProject(projectPath);
            validateSessionId(sessionId);
            return withRpc(async (rpc) => {
                const metadata = await rpc.request("thread/read", { threadId: sessionId, includeTurns: false });
                await validateThread(metadata?.thread, sessionId, project);
                const mode = metadata.thread.historyMode;
                if (mode != null && !["legacy", "default", "paginated"].includes(mode)) { throw providerError("UNSUPPORTED_HISTORY", "지원되지 않는 Codex 기록 형식입니다."); }
                const warnings = new Set();
                const seenItems = new Set();
                const messagesNewest = [];
                let complete = true;
                let turnCount = 0;
                let textBytes = 0;
                function collect(turnsNewest) {
                    for (const turn of turnsNewest) {
                        if (turnCount >= 1000 || messagesNewest.length >= 200) { complete = false; warnings.add("HISTORY_LIMIT"); return false; }
                        turnCount++;
                        if (turn?.status === "inProgress") { warnings.add("IN_PROGRESS"); complete = false; }
                        if (!Array.isArray(turn?.items) || (turn.itemsView && turn.itemsView !== "full")) { warnings.add("INCOMPLETE_ITEMS"); complete = false; continue; }
                        for (const item of [...turn.items].reverse()) {
                            if (!["userMessage", "agentMessage"].includes(item?.type)) { warnings.add("EXCLUDED_CONTENT"); continue; }
                            if (typeof item.id !== "string" || !item.id) { warnings.add("INCOMPLETE_ITEMS"); complete = false; continue; }
                            if (seenItems.has(item.id)) { warnings.add("DUPLICATE_ITEMS"); complete = false; continue; }
                            let text;
                            if (item.type === "agentMessage") { text = item.text; }
                            else if (Array.isArray(item.content)) {
                                const blocks = item.content.filter((block) => block?.type === "text" && typeof block.text === "string");
                                text = blocks.map((block) => block.text).join("\n");
                                if (blocks.length !== item.content.length) { warnings.add("EXCLUDED_CONTENT"); }
                                if (item.content.some((block) => block?.type === "text" && typeof block.text !== "string")) { warnings.add("INCOMPLETE_ITEMS"); complete = false; }
                            }
                            if (typeof text !== "string") { warnings.add("INCOMPLETE_ITEMS"); complete = false; continue; }
                            seenItems.add(item.id);
                            if (!text) { continue; }
                            if (messagesNewest.length >= 200) { complete = false; warnings.add("HISTORY_LIMIT"); return false; }
                            textBytes += Buffer.byteLength(text, "utf8");
                            if (textBytes > 32 * 1024 * 1024) { throw providerError("SESSION_TOO_LARGE", "세션 텍스트 크기 제한을 초과했습니다."); }
                            messagesNewest.push({ role: item.type === "userMessage" ? "user" : "assistant", text });
                        }
                    }
                    return true;
                }
                if (mode === "paginated") {
                    let cursor;
                    const cursors = new Set();
                    for (let pages = 0; pages < 1000; pages++) {
                        const result = await rpc.request("thread/turns/list", { threadId: sessionId, limit: 50, sortDirection: "desc", itemsView: "full", ...(cursor ? { cursor } : {}) });
                        if (!Array.isArray(result?.data)) { throw new Error(); }
                        if (!collect(result.data)) { break; }
                        if (!result.nextCursor) { break; }
                        if (cursors.has(result.nextCursor)) { warnings.add("REPEATED_CURSOR"); complete = false; break; }
                        cursors.add(result.nextCursor);
                        cursor = result.nextCursor;
                        if (messagesNewest.length >= 200 || turnCount >= 1000 || pages === 999) { warnings.add("HISTORY_LIMIT"); complete = false; break; }
                    }
                } else {
                    const result = await rpc.request("thread/read", { threadId: sessionId, includeTurns: true });
                    await validateThread(result?.thread, sessionId, project);
                    if (!Array.isArray(result.thread.turns)) { throw new Error(); }
                    collect([...result.thread.turns].reverse());
                }
                return { sessionId, projectPath: project, messages: messagesNewest.reverse(), historyComplete: complete, warnings: [...warnings] };
            });
        },
    };
}

module.exports = { createCodexProvider, resolveCodexCommand, SOURCE_KINDS };
