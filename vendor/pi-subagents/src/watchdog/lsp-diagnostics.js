import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const TS_JS_EXTENSIONS = new Map([
    [".ts", "typescript"],
    [".tsx", "typescriptreact"],
    [".mts", "typescript"],
    [".cts", "typescript"],
    [".js", "javascript"],
    [".jsx", "javascriptreact"],
    [".mjs", "javascript"],
    [".cjs", "javascript"],
]);
const PROVIDER_NAME = "typescript-language-server";
const MAX_MESSAGE_LENGTH = 500;
const MAX_STDERR_LENGTH = 2_000;
const SHUTDOWN_TIMEOUT_MS = 250;
function normalizeRelPath(value) {
    return value.replaceAll(path.sep, "/").replace(/^\.\//, "");
}
function isPathInsideRoot(absPath, root) {
    const rel = path.relative(root, absPath);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
function languageIdForPath(filePath) {
    return TS_JS_EXTENSIONS.get(path.extname(filePath).toLowerCase());
}
function trimDiagnosticMessage(message) {
    const normalized = message.replace(/\s+/g, " ").trim();
    return normalized.length > MAX_MESSAGE_LENGTH ? `${normalized.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : normalized;
}
function severityFromLsp(value) {
    if (value === 1)
        return "error";
    if (value === 2)
        return "warning";
    if (value === 3)
        return "info";
    return "hint";
}
function pathExecutable(filePath) {
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile())
            return false;
        if (process.platform === "win32")
            return true;
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
function pathExecutableNames(name) {
    if (process.platform !== "win32")
        return [name];
    const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
    return [name, ...extensions.map((ext) => `${name}${ext.toLowerCase()}`), ...extensions.map((ext) => `${name}${ext.toUpperCase()}`)];
}
function resolveTypeScriptLanguageServer(root) {
    for (const name of pathExecutableNames(PROVIDER_NAME)) {
        const local = path.join(root, "node_modules", ".bin", name);
        if (pathExecutable(local))
            return { command: local, args: ["--stdio"], label: `${PROVIDER_NAME} (project)` };
    }
    for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        for (const name of pathExecutableNames(PROVIDER_NAME)) {
            const candidate = path.join(dir, name);
            if (pathExecutable(candidate))
                return { command: candidate, args: ["--stdio"], label: PROVIDER_NAME };
        }
    }
    return undefined;
}
function collectTargetFiles(root, changedPaths, maxFiles) {
    const targets = [];
    const skippedPaths = [];
    for (const changedPath of changedPaths) {
        const relPath = normalizeRelPath(changedPath);
        const absPath = path.resolve(root, relPath);
        const languageId = languageIdForPath(absPath);
        if (!languageId || !isPathInsideRoot(absPath, root)) {
            skippedPaths.push(relPath);
            continue;
        }
        let stat;
        try {
            stat = fs.statSync(absPath);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                skippedPaths.push(relPath);
                continue;
            }
            throw error;
        }
        if (!stat.isFile()) {
            skippedPaths.push(relPath);
            continue;
        }
        if (targets.length >= maxFiles) {
            skippedPaths.push(relPath);
            continue;
        }
        targets.push({ relPath, absPath, uri: pathToFileURL(absPath).href, languageId });
    }
    return { targets, skippedPaths };
}
function diagnosticIdentity(diagnostic) {
    return createHash("sha256")
        .update([
        diagnostic.path,
        diagnostic.severity,
        diagnostic.source,
        diagnostic.code ?? "",
        diagnostic.message,
    ].join("\n"))
        .digest("hex");
}
export class WatchdogLspDiagnosticsLedger {
    seen = new Map();
    reset() {
        this.seen.clear();
    }
    reduce(result) {
        if (result.status === "disabled" || result.status === "unavailable" || result.status === "failed")
            return result;
        const currentByPath = new Map();
        const fresh = [];
        for (const diagnostic of result.diagnostics) {
            const identity = diagnosticIdentity(diagnostic);
            const current = currentByPath.get(diagnostic.path) ?? new Set();
            current.add(identity);
            currentByPath.set(diagnostic.path, current);
            if (!this.seen.get(diagnostic.path)?.has(identity))
                fresh.push(diagnostic);
        }
        for (const [filePath, identities] of currentByPath)
            this.seen.set(filePath, identities);
        if (result.status === "ok") {
            for (const checkedPath of result.checkedPaths) {
                if (!currentByPath.has(checkedPath))
                    this.seen.delete(checkedPath);
            }
        }
        return { ...result, diagnostics: fresh };
    }
}
function formatDiagnostic(diagnostic) {
    const code = diagnostic.code ? ` ${diagnostic.code}` : "";
    return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code} ${diagnostic.source}: ${diagnostic.message}`;
}
export function formatWatchdogLspDiagnosticsBlock(result) {
    const actionable = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning");
    if (!actionable.length)
        return "";
    return [
        "LSP diagnostics:",
        ...actionable.map((diagnostic) => `- ${formatDiagnostic(diagnostic)}`),
    ].join("\n");
}
export function watchdogWarningFromLspDiagnostics(result) {
    const actionable = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning");
    if (!actionable.length)
        return undefined;
    const errors = actionable.filter((diagnostic) => diagnostic.severity === "error");
    const severity = errors.length ? "blocker" : "concern";
    const primary = errors[0] ?? actionable[0];
    const count = errors.length || actionable.length;
    const kind = errors.length ? "error" : "warning";
    const evidence = actionable.slice(0, 5).map(formatDiagnostic).join("\n");
    return {
        severity,
        category: "correctness",
        importance: "high",
        source: "lsp",
        summary: `LSP found ${count} ${kind}${count === 1 ? "" : "s"} in changed ${count === 1 ? "file" : "files"}.`,
        evidence: evidence || formatDiagnostic(primary),
        recommendedAction: "Fix the reported diagnostics or explain why they are expected before accepting the change.",
    };
}
function withTimeout(promise, timeoutMs, message, signal) {
    if (signal?.aborted)
        return Promise.reject(new Error("aborted"));
    let timer;
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            if (timer)
                clearTimeout(timer);
            reject(new Error("aborted"));
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            reject(new Error(message));
        }, timeoutMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        promise.then((value) => {
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(value);
        }, (error) => {
            if (timer)
                clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
    });
}
class JsonRpcLspClient {
    nextId = 1;
    stdoutBuffer = Buffer.alloc(0);
    pending = new Map();
    diagnostics = new Map();
    child;
    stderr = "";
    exited = false;
    terminating = false;
    exitWaiters = [];
    constructor(child) {
        this.child = child;
        child.stdout.on("data", (chunk) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk) => {
            this.stderr = `${this.stderr}${chunk.toString("utf-8")}`.slice(-MAX_STDERR_LENGTH);
        });
        child.on("error", (error) => {
            this.exited = true;
            this.rejectPending(error);
            this.resolveExitWaiters();
        });
        child.on("exit", (code, signal) => {
            this.exited = true;
            this.rejectPending(new Error(`language server exited${code === null ? "" : ` with code ${code}`}${signal ? ` signal ${signal}` : ""}`));
            this.resolveExitWaiters();
        });
    }
    request(method, params, timeoutMs, signal) {
        const id = this.nextId++;
        const promise = new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({ jsonrpc: "2.0", id, method, params });
        });
        return withTimeout(promise, timeoutMs, `${method} timed out`, signal);
    }
    notify(method, params) {
        this.send({ jsonrpc: "2.0", method, params });
    }
    async shutdown() {
        if (this.exited)
            return;
        if (!this.terminating) {
            try {
                await this.request("shutdown", null, SHUTDOWN_TIMEOUT_MS);
                this.notify("exit", null);
            }
            catch {
                this.kill();
            }
        }
        await this.waitForExit(SHUTDOWN_TIMEOUT_MS);
    }
    kill() {
        if (this.exited || this.terminating)
            return;
        this.terminating = true;
        this.child.kill("SIGTERM");
    }
    stderrTail() {
        return this.stderr.trim();
    }
    send(payload) {
        if (this.exited)
            throw new Error("language server already exited");
        const body = JSON.stringify(payload);
        this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
    }
    handleStdout(chunk) {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        while (true) {
            const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
            if (headerEnd === -1)
                return;
            const header = this.stdoutBuffer.slice(0, headerEnd).toString("utf-8");
            const match = header.match(/content-length:\s*(\d+)/i);
            if (!match) {
                this.stdoutBuffer = this.stdoutBuffer.slice(headerEnd + 4);
                continue;
            }
            const length = Number(match[1]);
            const bodyStart = headerEnd + 4;
            const bodyEnd = bodyStart + length;
            if (this.stdoutBuffer.length < bodyEnd)
                return;
            const body = this.stdoutBuffer.slice(bodyStart, bodyEnd).toString("utf-8");
            this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);
            try {
                this.handleMessage(JSON.parse(body));
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.failProtocol(new Error(`Invalid LSP JSON-RPC response: ${message}`));
                return;
            }
        }
    }
    handleMessage(message) {
        if (message.method === "textDocument/publishDiagnostics") {
            const params = message.params;
            if (typeof params?.uri === "string" && Array.isArray(params.diagnostics)) {
                this.diagnostics.set(params.uri, params.diagnostics);
            }
            return;
        }
        if (message.id === undefined || message.id === null)
            return;
        const pending = this.pending.get(message.id);
        if (!pending)
            return;
        this.pending.delete(message.id);
        if (message.error) {
            pending.reject(new Error(message.error.message || `LSP request ${message.id} failed`));
        }
        else {
            pending.resolve(message.result);
        }
    }
    failProtocol(error) {
        if (this.exited)
            return;
        this.rejectPending(error);
        this.kill();
    }
    waitForExit(timeoutMs) {
        if (this.exited)
            return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, timeoutMs);
            this.exitWaiters.push(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
    resolveExitWaiters() {
        for (const resolve of this.exitWaiters.splice(0))
            resolve();
    }
    rejectPending(error) {
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
    }
}
function convertDiagnostics(target, diagnostics) {
    return diagnostics
        .filter((diagnostic) => typeof diagnostic.message === "string" && diagnostic.range?.start)
        .map((diagnostic) => ({
        path: target.relPath,
        line: Math.max(1, (diagnostic.range?.start?.line ?? 0) + 1),
        column: Math.max(1, (diagnostic.range?.start?.character ?? 0) + 1),
        severity: severityFromLsp(diagnostic.severity),
        source: diagnostic.source || PROVIDER_NAME,
        ...(diagnostic.code !== undefined ? { code: String(diagnostic.code) } : {}),
        message: trimDiagnosticMessage(diagnostic.message ?? ""),
    }));
}
function initializeParams(root) {
    const rootUri = pathToFileURL(root).href;
    return {
        processId: process.pid,
        rootUri,
        capabilities: {
            textDocument: {
                publishDiagnostics: { relatedInformation: false, versionSupport: true },
            },
            workspace: { configuration: false, workspaceFolders: true },
        },
        workspaceFolders: [{ uri: rootUri, name: path.basename(root) || "workspace" }],
    };
}
async function waitForDiagnostics(client, targets, timeoutMs, signal) {
    const started = Date.now();
    while (!signal?.aborted && Date.now() - started < timeoutMs) {
        if (targets.every((target) => client.diagnostics.has(target.uri)))
            return true;
        await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, timeoutMs - (Date.now() - started)))));
    }
    return targets.every((target) => client.diagnostics.has(target.uri));
}
async function collectWithTypeScriptLanguageServer(input) {
    const started = Date.now();
    const child = spawn(input.command.command, input.command.args, {
        windowsHide: true,
        cwd: input.root,
        stdio: "pipe",
        env: { ...process.env, NO_COLOR: "1" },
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(input.command.command),
    });
    const client = new JsonRpcLspClient(child);
    const remaining = () => Math.max(1, input.config.timeoutMs - (Date.now() - started));
    const abort = () => client.kill();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
        await client.request("initialize", initializeParams(input.root), remaining(), input.signal);
        client.notify("initialized", {});
        for (const target of input.targets) {
            const text = fs.readFileSync(target.absPath, "utf-8");
            client.notify("textDocument/didOpen", {
                textDocument: { uri: target.uri, languageId: target.languageId, version: 1, text },
            });
            client.notify("textDocument/didSave", {
                textDocument: { uri: target.uri },
                text,
            });
        }
        const complete = await waitForDiagnostics(client, input.targets, remaining(), input.signal);
        const diagnostics = input.targets
            .flatMap((target) => convertDiagnostics(target, client.diagnostics.get(target.uri) ?? []))
            .slice(0, input.config.maxDiagnostics);
        return {
            status: complete ? "ok" : "timeout",
            provider: input.command.label,
            checkedPaths: input.targets.map((target) => target.relPath),
            skippedPaths: input.skippedPaths,
            diagnostics,
            ...(complete ? {} : { message: `Timed out waiting ${input.config.timeoutMs}ms for fresh LSP diagnostics.` }),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timedOut = message.includes("timed out") || message === "aborted";
        const stderr = client.stderrTail();
        return {
            status: timedOut ? "timeout" : "failed",
            provider: input.command.label,
            checkedPaths: input.targets.map((target) => target.relPath),
            skippedPaths: input.skippedPaths,
            diagnostics: [],
            message: stderr ? `${message}; ${stderr}` : message,
        };
    }
    finally {
        input.signal?.removeEventListener("abort", abort);
        await client.shutdown();
    }
}
export async function collectWatchdogLspDiagnostics(request) {
    if (!request.config.enabled) {
        return { status: "disabled", checkedPaths: [], skippedPaths: [], diagnostics: [] };
    }
    const root = path.resolve(request.root || request.cwd);
    const { targets, skippedPaths } = collectTargetFiles(root, request.changedPaths, request.config.maxFiles);
    if (!targets.length) {
        return {
            status: "skipped",
            checkedPaths: [],
            skippedPaths,
            diagnostics: [],
            message: "No changed TypeScript or JavaScript files to check.",
        };
    }
    const command = resolveTypeScriptLanguageServer(root);
    if (!command) {
        return {
            status: "unavailable",
            provider: PROVIDER_NAME,
            checkedPaths: [],
            skippedPaths: [...skippedPaths, ...targets.map((target) => target.relPath)],
            diagnostics: [],
            message: `${PROVIDER_NAME} was not found in project node_modules/.bin or PATH.`,
        };
    }
    try {
        return await collectWithTypeScriptLanguageServer({ root, targets, skippedPaths, command, config: request.config, signal: request.signal });
    }
    catch (error) {
        return {
            status: "failed",
            provider: command.label,
            checkedPaths: targets.map((target) => target.relPath),
            skippedPaths,
            diagnostics: [],
            message: error instanceof Error ? error.message : String(error),
        };
    }
}
//# sourceMappingURL=lsp-diagnostics.js.map