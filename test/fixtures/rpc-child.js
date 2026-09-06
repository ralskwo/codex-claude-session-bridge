const readline = require("node:readline");
const mode = process.argv[2];
const lines = readline.createInterface({ input: process.stdin });
let output = Promise.resolve();
lines.on("line", (line) => {
    const request = JSON.parse(line);
    if (!request.id) {
        return;
    }
    if (mode === "hang") {
        return;
    }
    if (mode === "eof") {
        process.exit(0);
    }
    if (mode === "oversized") {
        process.stdout.write("x".repeat(4096));
        return;
    }
    if (mode === "malformed") {
        process.stdout.write("not json\n");
        return;
    }
    process.stderr.write("secret-token-hidden\n");
    const response = mode === "error"
        ? { id: request.id, error: { code: -32603, message: "secret-token-hidden" } }
        : { id: request.id, result: { method: request.method } };
    const encoded = JSON.stringify(response) + "\n";
    output = output.then(async () => {
        process.stdout.write(JSON.stringify({ method: "notification", params: {} }) + "\n");
        process.stdout.write(encoded.slice(0, 9));
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.stdout.write(encoded.slice(9));
    });
});
