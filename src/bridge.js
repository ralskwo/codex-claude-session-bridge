const { canonicalProject, assertSameProject } = require("./project.js");
const { redact, boundMessages, renderHandoff, ensureOutputSize, safeError, bridgeError, normalizeWarnings, safeHead } = require("./content.js");

function validId(value) {
    return typeof value === "string" && value.length >= 1 && value.length <= 200
        && !/[\u0000-\u001f\u007f-\u009f/\\]/.test(value);
}

function validateOptions(options, kind) {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype) throw bridgeError("INVALID_ARGUMENT");
    const keys = kind === "list" ? ["provider", "projectPath", "limit", "offset"]
        : ["provider", "projectPath", "sessionId", "maxMessages", "maxChars"];
    for (const key of Reflect.ownKeys(options)) {
        if (!keys.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), "value")) throw bridgeError("INVALID_ARGUMENT");
    }
    if (!["codex", "claude"].includes(options.provider)) throw bridgeError("INVALID_ARGUMENT");
    if (kind !== "list" && !validId(options.sessionId)) throw bridgeError("INVALID_ARGUMENT");
    const limits = kind === "list" ? { limit: [20, 1, 100], offset: [0, 0, 10000] }
        : { maxMessages: [40, 1, 200], maxChars: [24000, 1000, 100000] };
    const result = { ...options };
    for (const [key, [fallback, min, max]] of Object.entries(limits)) {
        const value = options[key] === undefined ? fallback : options[key];
        if (!Number.isInteger(value) || value < min || value > max) throw bridgeError("INVALID_ARGUMENT");
        result[key] = value;
    }
    return result;
}

function createBridge({ codex, claude }) {
    const providers = { codex, claude };

    async function execute(options, kind, callback) {
        try {
            const args = validateOptions(options, kind);
            args.projectPath = await canonicalProject(args.projectPath);
            const provider = providers[args.provider];
            if (!provider || typeof provider[kind === "list" ? "list" : "read"] !== "function") throw bridgeError("PROVIDER_ERROR");
            return ensureOutputSize(await callback(provider, args));
        } catch (error) {
            throw bridgeError(safeError(error).code);
        }
    }

    async function listSessions(options) {
        return execute(options, "list", async (provider, args) => {
            const result = await provider.list({ projectPath: args.projectPath, limit: args.limit, offset: args.offset });
            if (!result || !Array.isArray(result.sessions) || result.sessions.length > 10000
                || !(result.nextOffset === null || (Number.isInteger(result.nextOffset) && result.nextOffset > args.offset && result.nextOffset <= 10000))) {
                throw bridgeError("INVALID_METADATA");
            }
            const sessions = [];
            const seen = new Set();
            const additional = [];
            for (const session of result.sessions) {
                try {
                    if (!session || !validId(session.sessionId) || !Number.isSafeInteger(session.updatedAt) || session.updatedAt < 0
                        || (session.title !== undefined && typeof session.title !== "string")) throw bridgeError("INVALID_METADATA");
                    await assertSameProject(session.projectPath, args.projectPath);
                    if (seen.has(session.sessionId)) continue;
                    seen.add(session.sessionId);
                    sessions.push({ provider: args.provider, sessionId: session.sessionId, projectPath: args.projectPath,
                        title: safeHead(redact(session.title || ""), 200), updatedAt: session.updatedAt });
                } catch {
                    additional.push("INVALID_METADATA");
                }
            }
            sessions.sort((a, b) => b.updatedAt - a.updatedAt || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0));
            return { sessions: sessions.slice(0, args.limit), nextOffset: result.nextOffset, warnings: normalizeWarnings(result.warnings, additional) };
        });
    }

    async function readSnapshot(provider, args) {
        const result = await provider.read({ projectPath: args.projectPath, sessionId: args.sessionId });
        if (!result || !validId(result.sessionId) || result.sessionId !== args.sessionId
            || !Array.isArray(result.messages) || typeof result.historyComplete !== "boolean") throw bridgeError("INVALID_METADATA");
        await assertSameProject(result.projectPath, args.projectPath);
        const bounded = boundMessages(result.messages, { maxMessages: args.maxMessages, maxChars: args.maxChars, historyComplete: result.historyComplete });
        const additional = [];
        if (result.messages.some((message) => !message || !["user", "assistant"].includes(message.role)
            || typeof message.text !== "string")) additional.push("EXCLUDED_CONTENT");
        if (bounded.truncated) additional.push(result.historyComplete ? "TRUNCATED" : "HISTORY_LIMIT");
        return { provider: args.provider, sessionId: args.sessionId, projectPath: args.projectPath,
            ...bounded, historyComplete: result.historyComplete, warnings: normalizeWarnings(result.warnings, additional) };
    }

    async function readSession(options) {
        return execute(options, "read", readSnapshot);
    }

    async function prepareHandoff(options) {
        return execute(options, "read", async (provider, args) => {
            const snapshot = await readSnapshot(provider, args);
            return { ...snapshot, context: renderHandoff(snapshot) };
        });
    }

    return { listSessions, readSession, prepareHandoff };
}

module.exports = { createBridge };
