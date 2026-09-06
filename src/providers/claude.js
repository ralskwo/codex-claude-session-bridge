const { providerError } = require("./rpc");
const { canonicalProject, assertSameProject, validateSessionId, validatePage, filterSessions, pageSessions, redactFailure } = require("./common");

function createClaudeProvider(options = {}) {
    async function reader() {
        const sdk = options.sdk || await import("@anthropic-ai/claude-agent-sdk");
        if (!["listSessions", "getSessionInfo", "getSessionMessages"].every((name) => typeof sdk[name] === "function")) {
            throw providerError("UNSUPPORTED_CLAUDE_API", "지원되지 않는 Claude SDK 읽기 API입니다.");
        }
        return sdk;
    }

    return {
        async list({ projectPath, limit = 20, offset = 0 }) {
            try {
                const project = await canonicalProject(projectPath);
                const page = validatePage(limit, offset);
                const sdk = await reader();
                const rows = await sdk.listSessions({ dir: project, includeWorktrees: false, includeProgrammatic: true, limit: 10000, offset: 0 });
                if (!Array.isArray(rows)) { throw new Error(); }
                const warnings = new Set(rows.length >= 10000 ? ["SCAN_LIMIT"] : []);
                const sessions = await filterSessions(rows.slice(0, 10000).map((row) => ({
                    sessionId: row.sessionId,
                    projectPath: row.cwd,
                    title: row.customTitle || row.summary || row.firstPrompt || "",
                    updatedAt: row.lastModified,
                })), project);
                return pageSessions(sessions, page, warnings);
            } catch (error) {
                throw redactFailure(error, "Claude");
            }
        },

        async read({ projectPath, sessionId }) {
            try {
                const project = await canonicalProject(projectPath);
                validateSessionId(sessionId);
                const sdk = await reader();
                const info = await sdk.getSessionInfo(sessionId, { dir: project });
                if (!info) { throw providerError("SESSION_NOT_FOUND", "세션 메타데이터를 찾을 수 없습니다."); }
                if (info.sessionId !== sessionId) { throw providerError("SESSION_MISMATCH", "세션 ID가 일치하지 않습니다."); }
                await assertSameProject(info.cwd, project);
                if (!Number.isSafeInteger(info.fileSize) || info.fileSize < 0 || info.fileSize > 64 * 1024 * 1024) {
                    throw providerError("SESSION_TOO_LARGE", "세션 파일 크기를 확인할 수 없거나 크기 제한을 초과했습니다.");
                }
                const rows = await sdk.getSessionMessages(sessionId, { dir: project, includeSystemMessages: false });
                if (!Array.isArray(rows)) { throw new Error(); }
                const messages = [];
                const warnings = new Set();
                let bytes = 0;
                for (const row of rows) {
                    if (row.session_id != null && row.session_id !== sessionId) {
                        throw providerError("SESSION_MISMATCH", "메시지의 세션 ID가 일치하지 않습니다.");
                    }
                    if (!["user", "assistant"].includes(row.type)) {
                        warnings.add("EXCLUDED_CONTENT");
                        continue;
                    }
                    const content = row.message?.content;
                    let text;
                    if (typeof content === "string") {
                        text = content;
                    } else if (Array.isArray(content)) {
                        text = content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
                        if (content.some((block) => block?.type !== "text")) { warnings.add("EXCLUDED_CONTENT"); }
                        if (content.some((block) => block?.type === "text" && typeof block.text !== "string")) { warnings.add("INCOMPLETE_ITEMS"); }
                    } else {
                        warnings.add("INCOMPLETE_ITEMS");
                        continue;
                    }
                    bytes += Buffer.byteLength(text, "utf8");
                    if (bytes > 32 * 1024 * 1024) { throw providerError("SESSION_TOO_LARGE", "세션 텍스트 크기 제한을 초과했습니다."); }
                    if (text) { messages.push({ role: row.type, text }); }
                }
                return { sessionId, projectPath: project, messages, historyComplete: !warnings.has("INCOMPLETE_ITEMS"), warnings: [...warnings] };
            } catch (error) {
                throw redactFailure(error, "Claude");
            }
        },
    };
}

module.exports = { createClaudeProvider };
