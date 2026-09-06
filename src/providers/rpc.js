const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");

const METHODS = new Set(["initialize", "thread/list", "thread/read", "thread/turns/list"]);
const OWN_ERRORS = new WeakSet();

function providerError(code, message) {
    const error = new Error(message);
    error.code = code;
    OWN_ERRORS.add(error);
    return error;
}

class RpcClient {
    constructor({ command, args = [], env = process.env, timeoutMs = 15000, maxResponseBytes = 32 * 1024 * 1024 }) {
        this.timeoutMs = timeoutMs;
        this.maxResponseBytes = maxResponseBytes;
        this.pending = new Map();
        this.nextId = 1;
        this.closed = false;
        this.buffer = "";
        this.bytes = 0;
        this.decoder = new StringDecoder("utf8");
        this.child = spawn(command, args, { shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
        this.exit = new Promise((resolve) => {
            this.child.once("close", () => {
                clearTimeout(this.killTimer);
                this.fail(providerError("RPC_EOF", "Codex 읽기 프로세스가 종료되었습니다."));
                resolve();
            });
        });
        this.child.on("error", () => this.fail(providerError("RPC_START", "Codex 읽기 프로세스를 실행하지 못했습니다.")));
        this.child.stdin.on("error", () => this.fail(providerError("RPC_EOF", "Codex 읽기 프로세스 연결이 종료되었습니다.")));
        // 원본 stderr에는 개인정보가 포함될 수 있으므로 저장하거나 전달하지 않는다.
        this.child.stderr.on("data", () => {});
        this.child.stdout.on("data", (chunk) => this.receive(chunk));
    }

    receive(chunk) {
        if (this.closed) { return; }
        this.bytes += chunk.length;
        if (this.bytes > this.maxResponseBytes) {
            this.fail(providerError("RESPONSE_TOO_LARGE", "Codex 응답 크기 제한을 초과했습니다."));
            return;
        }
        this.buffer += this.decoder.write(chunk);
        let newline;
        while ((newline = this.buffer.indexOf("\n")) !== -1) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (!line) { continue; }
            let message;
            try {
                message = JSON.parse(line);
                if (!message || typeof message !== "object" || Array.isArray(message)) { throw new Error(); }
            } catch {
                this.fail(providerError("RPC_PROTOCOL", "Codex 응답 형식을 읽을 수 없습니다."));
                return;
            }
            const pending = this.pending.get(message.id);
            if (!pending) { continue; }
            clearTimeout(pending.timer);
            this.pending.delete(message.id);
            if (message.error) {
                pending.reject(providerError("CODEX_READ_ERROR", "Codex 읽기 API 오류입니다. 설치된 Codex 버전과 기록 형식의 호환성을 확인해주세요."));
            } else if (!Object.hasOwn(message, "result")) {
                pending.reject(providerError("RPC_PROTOCOL", "Codex 응답 형식을 읽을 수 없습니다."));
            } else {
                pending.resolve(message.result);
            }
        }
    }

    request(method, params) {
        if (!METHODS.has(method)) {
            return Promise.reject(providerError("RPC_METHOD", "허용되지 않은 Codex API입니다."));
        }
        if (this.closed) {
            return Promise.reject(providerError("RPC_EOF", "Codex 읽기 프로세스가 종료되었습니다."));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(providerError("RPC_TIMEOUT", "Codex 읽기 요청 시간이 초과되었습니다.")), this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        });
    }

    notify(method, params = {}) {
        if (method !== "initialized" || this.closed) {
            throw providerError("RPC_METHOD", "허용되지 않은 Codex API입니다.");
        }
        this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
    }

    fail(error) {
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        if (this.child.exitCode === null && this.child.signalCode === null) {
            this.child.kill();
            if (!this.killTimer) {
                this.killTimer = setTimeout(() => this.child.kill("SIGKILL"), 250);
                this.killTimer.unref();
            }
        }
    }

    async close() {
        this.fail(providerError("RPC_EOF", "Codex 읽기 프로세스가 종료되었습니다."));
        await this.exit;
    }
}

module.exports = { RpcClient, providerError, isProviderError: (error) => OWN_ERRORS.has(error) };
