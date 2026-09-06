const { canonicalProject, assertSameProject } = require("../project");
const { providerError, isProviderError } = require("./rpc");

function validateSessionId(sessionId) {
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 200) {
        throw providerError("INVALID_SESSION", "유효한 세션 ID가 필요합니다.");
    }
}

function validatePage(limit = 20, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 10000) {
        throw providerError("INVALID_LIMIT", "목록 범위가 올바르지 않습니다.");
    }
    return { limit, offset };
}

async function filterSessions(rows, projectPath) {
    const sessions = new Map();
    for (const row of rows) {
        if (!row || typeof row.sessionId !== "string" || !row.sessionId.trim() || row.sessionId.length > 200) { continue; }
        try {
            await assertSameProject(row.projectPath, projectPath);
        } catch {
            continue;
        }
        if (!Number.isSafeInteger(row.updatedAt) || row.updatedAt < 0) { continue; }
        if (!sessions.has(row.sessionId) || sessions.get(row.sessionId).updatedAt < row.updatedAt) {
            sessions.set(row.sessionId, { ...row, projectPath });
        }
    }
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.sessionId.localeCompare(b.sessionId));
}

function pageSessions(sessions, { limit, offset }, warnings) {
    return { sessions: sessions.slice(offset, offset + limit), nextOffset: offset + limit < sessions.length ? offset + limit : null, warnings: [...warnings] };
}

function redactFailure(error, source) {
    // 자체 검증 오류만 보존한다. SDK/서버 오류의 원문은 반환하지 않는다.
    if (isProviderError(error)) { return error; }
    if (error?.code === "INVALID_PROJECT") { return providerError("INVALID_PROJECT", "프로젝트 경로는 존재하는 디렉터리의 절대 경로여야 합니다."); }
    if (error?.code === "PROJECT_MISMATCH") { return providerError("PROJECT_MISMATCH", "선택한 세션의 프로젝트가 요청한 프로젝트와 다릅니다."); }
    return providerError("PROVIDER_ERROR", `${source} 세션 읽기에 실패했습니다.`);
}

module.exports = { canonicalProject, assertSameProject, validateSessionId, validatePage, filterSessions, pageSessions, redactFailure };
