const { ensureOutputSize, safeError } = require("./content.js");

const COMMANDS = Object.freeze({ list: "listSessions", read: "readSession", handoff: "prepareHandoff" });
const FLAGS = Object.freeze({ "--provider": "provider", "--project": "projectPath", "--session": "sessionId",
    "--limit": "limit", "--offset": "offset", "--max-messages": "maxMessages", "--max-chars": "maxChars" });
const NUMERIC = new Set(["limit", "offset", "maxMessages", "maxChars"]);
const HELP = "사용법: node src/cli.js list|read|handoff --provider codex|claude --project <절대경로> [--session <ID>]\n"
    + "목록: --limit 20 --offset 0 / 본문: --max-messages 40 --max-chars 24000\n"
    + "환경 점검: node src/cli.js doctor\n";

function parseArgs(argv) {
    const command = argv[0];
    if (!Object.hasOwn(COMMANDS, command)) {
        throw new Error("INVALID_COMMAND");
    }
    const args = {};
    for (let index = 1; index < argv.length; index += 2) {
        const flag = argv[index];
        const value = argv[index + 1];
        if (!Object.hasOwn(FLAGS, flag) || value === undefined || value.startsWith("--")) {
            throw new Error("INVALID_FLAG");
        }
        const key = FLAGS[flag];
        if (Object.hasOwn(args, key) || (NUMERIC.has(key) && !/^\d+$/.test(value))) {
            throw new Error("INVALID_FLAG");
        }
        args[key] = NUMERIC.has(key) ? Number(value) : value;
    }
    return { method: COMMANDS[command], args };
}

async function doctor() {
    const { resolveCodexCommand } = require("./providers/codex.js");
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const launch = await resolveCodexCommand();
    const readersAvailable = ["listSessions", "getSessionInfo", "getSessionMessages"]
        .every((name) => typeof sdk[name] === "function");
    if (!readersAvailable || Number(process.versions.node.split(".")[0]) < 22) {
        throw new Error("RUNTIME_UNSUPPORTED");
    }
    return { ok: true, node: process.version, codexExecutable: launch.command,
        claudeReadersAvailable: readersAvailable,
        note: "실행 환경을 확인했습니다. 세션 접근은 프로젝트를 지정한 list/read로 확인하세요. 모델 호출은 실행하지 않았습니다." };
}

async function runCli(argv, bridge, io = process) {
    try {
        if (argv.length === 0 || ["--help", "-h"].includes(argv[0])) {
            io.stdout.write(HELP);
            return 0;
        }
        let result;
        if (argv[0] === "doctor") {
            if (argv.length !== 1) {
                throw new Error("INVALID_FLAG");
            }
            result = await doctor();
        } else {
            const { method, args } = parseArgs(argv);
            const activeBridge = bridge ?? require("./server.js").defaultBridge();
            result = await activeBridge[method](args);
        }
        io.stdout.write(`${JSON.stringify(ensureOutputSize(result))}\n`);
        return 0;
    } catch (error) {
        io.stderr.write(`${JSON.stringify(safeError(error))}\n`);
        return 1;
    }
}

if (require.main === module) {
    runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { runCli, doctor };
