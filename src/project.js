const fs = require("node:fs/promises");
const path = require("node:path");

function projectError(code) {
    const error = new Error(code === "PROJECT_MISMATCH"
        ? "선택한 세션의 프로젝트가 요청한 프로젝트와 다릅니다."
        : "프로젝트 경로는 존재하는 디렉터리의 절대 경로여야 합니다.");
    error.code = code;
    return error;
}

async function canonicalProject(projectPath) {
    if (typeof projectPath !== "string" || !projectPath || projectPath.length > 4096
        || /[\u0000-\u001f\u007f]/.test(projectPath) || !path.isAbsolute(projectPath)) {
        throw projectError("INVALID_PROJECT");
    }
    try {
        const canonical = await fs.realpath(projectPath);
        if (canonical.length > 4096 || !(await fs.stat(canonical)).isDirectory()) {
            throw projectError("INVALID_PROJECT");
        }
        return process.platform === "win32" ? canonical.toLowerCase() : canonical;
    } catch {
        throw projectError("INVALID_PROJECT");
    }
}

async function assertSameProject(actual, expected) {
    const actualProject = await canonicalProject(actual);
    const expectedProject = await canonicalProject(expected);
    if (actualProject !== expectedProject) throw projectError("PROJECT_MISMATCH");
}

module.exports = { canonicalProject, assertSameProject };
