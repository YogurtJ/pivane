import { execFile } from "node:child_process";
function error(code, message, details) {
    return { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}
function failureText(execError, stderr) {
    const direct = stderr?.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (direct)
        return direct;
    const lines = execError.message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const withoutPrefix = lines.filter((line) => !/^Command failed:/.test(line));
    return withoutPrefix[0] ?? "tmux failed.";
}
function classifyFailure(text) {
    const lower = text.toLowerCase();
    if (lower.includes("can't find pane") || lower.includes("can't find window"))
        return "PANE_GONE";
    if (lower.includes("no server running") || lower.includes("no current client"))
        return "TMUX_UNAVAILABLE";
    return "TMUX_ERROR";
}
export function createTmuxClient(options = {}) {
    const bin = options.bin ?? process.env.TMUX_BIN ?? "tmux";
    const execImpl = options.exec ?? execFile;
    return {
        run(args, runOptions = {}) {
            return new Promise((resolve) => {
                let settled = false;
                const abort = () => finish(error("TIMEOUT", `tmux command '${args.join(" ")}' was aborted.`));
                const finish = (result) => {
                    if (settled)
                        return;
                    settled = true;
                    runOptions.signal?.removeEventListener("abort", abort);
                    resolve(result);
                };
                if (runOptions.signal?.aborted) {
                    abort();
                    return;
                }
                runOptions.signal?.addEventListener("abort", abort, { once: true });
                execImpl(bin, args, { timeout: runOptions.timeoutMs ?? 10_000, signal: runOptions.signal }, (execError, stdout, stderr) => {
                    if (execError) {
                        const code = execError.code;
                        if (code === "ENOENT") {
                            finish(error("TMUX_UNAVAILABLE", "tmux is not installed or is not on PATH."));
                            return;
                        }
                        // Node reports its own timeout expiry as a killed child, not as our abort listener firing.
                        const killed = execError;
                        if (killed.killed === true || killed.signal) {
                            finish(error("TIMEOUT", `tmux command '${args.join(" ")}' timed out.`));
                            return;
                        }
                        const text = failureText(execError, stderr);
                        const exitCode = Number(code);
                        finish(error(exitCode === 127 ? "TMUX_UNAVAILABLE" : classifyFailure(text), text));
                        return;
                    }
                    finish({ ok: true, data: stdout.trim() });
                });
            });
        },
    };
}
//# sourceMappingURL=client.js.map