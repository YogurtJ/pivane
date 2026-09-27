import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../../shared/utils.js";
import { isUnexplainedProcessSignal } from "./process-signal.js";
const ROTATE_READ_THRESHOLD = 1200;
const ROTATE_KEEP = 1000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REDACTED_TASK = "[redacted]";
const historyFileStates = new Map();
function getHistoryPath() {
    return path.join(getAgentDir(), "run-history.jsonl");
}
function hashTask(task) {
    return createHash("sha256").update(task).digest("hex");
}
function hardenHistoryStorage(historyPath) {
    const historyDir = path.dirname(historyPath);
    fs.mkdirSync(historyDir, { recursive: true, mode: PRIVATE_DIR_MODE });
    try {
        if ((fs.statSync(historyDir).mode & 0o777) !== PRIVATE_DIR_MODE)
            fs.chmodSync(historyDir, PRIVATE_DIR_MODE);
    }
    catch { }
    try {
        if ((fs.statSync(historyPath).mode & 0o777) !== PRIVATE_FILE_MODE)
            fs.chmodSync(historyPath, PRIVATE_FILE_MODE);
    }
    catch { }
}
function sanitizeHistoryLine(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        return undefined;
    }
    if (!value || typeof value !== "object")
        return undefined;
    const record = value;
    const task = typeof record.task === "string" ? record.task : "";
    const taskHash = typeof record.taskHash === "string" && record.taskHash
        ? record.taskHash
        : task && task !== REDACTED_TASK
            ? hashTask(task)
            : undefined;
    return JSON.stringify({
        ...record,
        task: REDACTED_TASK,
        ...(taskHash ? { taskHash } : {}),
    });
}
function sanitizeHistoryLines(raw) {
    const lines = [];
    let changed = false;
    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const sanitized = sanitizeHistoryLine(trimmed);
        if (!sanitized) {
            changed = true;
            continue;
        }
        if (sanitized !== trimmed)
            changed = true;
        lines.push(sanitized);
    }
    return { lines, changed };
}
function writePrivateHistory(historyPath, lines) {
    fs.writeFileSync(historyPath, lines.length ? `${lines.join("\n")}\n` : "", { encoding: "utf-8", mode: PRIVATE_FILE_MODE });
    try {
        fs.chmodSync(historyPath, PRIVATE_FILE_MODE);
    }
    catch { }
}
function rememberHistoryFile(historyPath, lineCount) {
    const stat = fs.statSync(historyPath);
    historyFileStates.set(historyPath, {
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        size: stat.size,
        ino: stat.ino,
        lineCount,
    });
    if (historyFileStates.size > 8)
        historyFileStates.delete(historyFileStates.keys().next().value);
}
function sanitizeHistoryFile(historyPath) {
    let stat;
    try {
        stat = fs.statSync(historyPath);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return 0;
        throw error;
    }
    const cached = historyFileStates.get(historyPath);
    if (cached
        && cached.mtimeMs === stat.mtimeMs
        && cached.ctimeMs === stat.ctimeMs
        && cached.size === stat.size
        && cached.ino === stat.ino) {
        return cached.lineCount;
    }
    const raw = fs.readFileSync(historyPath, "utf-8");
    const { lines, changed } = sanitizeHistoryLines(raw);
    if (changed)
        writePrivateHistory(historyPath, lines);
    rememberHistoryFile(historyPath, lines.length);
    return lines.length;
}
function appendPrivateHistoryLine(historyPath, line) {
    const fd = fs.openSync(historyPath, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, PRIVATE_FILE_MODE);
    try {
        fs.writeSync(fd, `${line}\n`);
    }
    finally {
        fs.closeSync(fd);
    }
}
export function recordRun(agent, task, exitCode, durationMs, terminal = {}) {
    try {
        const outcome = terminal.stopped
            ? "stopped"
            : terminal.interrupted
                ? "interrupted"
                : terminal.timedOut
                    ? "timed_out"
                    : exitCode !== 0 && isUnexplainedProcessSignal(terminal)
                        ? "stopped"
                        : exitCode === 0 ? "completed" : "failed";
        const entry = {
            agent,
            task: REDACTED_TASK,
            taskHash: hashTask(task),
            ts: Math.floor(Date.now() / 1000),
            status: exitCode === 0 ? "ok" : "error",
            outcome,
            duration: durationMs,
            ...(exitCode !== 0 ? { exit: exitCode } : {}),
        };
        const historyPath = getHistoryPath();
        hardenHistoryStorage(historyPath);
        let lineCount;
        try {
            lineCount = sanitizeHistoryFile(historyPath);
        }
        catch { }
        appendPrivateHistoryLine(historyPath, JSON.stringify(entry));
        if (lineCount === undefined)
            historyFileStates.delete(historyPath);
        else
            rememberHistoryFile(historyPath, lineCount + 1);
    }
    catch {
        // Best-effort — never crash the execution flow for history recording
    }
}
export function loadRunsForAgent(agent) {
    const historyPath = getHistoryPath();
    try {
        hardenHistoryStorage(historyPath);
    }
    catch { }
    if (!fs.existsSync(historyPath))
        return [];
    let raw;
    try {
        raw = fs.readFileSync(historyPath, "utf-8");
    }
    catch {
        return [];
    }
    let { lines, changed } = sanitizeHistoryLines(raw);
    if (lines.length > ROTATE_READ_THRESHOLD) {
        lines = lines.slice(-ROTATE_KEEP);
        changed = true;
    }
    try {
        if (changed)
            writePrivateHistory(historyPath, lines);
        rememberHistoryFile(historyPath, lines.length);
    }
    catch { }
    return lines
        .map((line) => { try {
        return JSON.parse(line);
    }
    catch {
        return undefined;
    } })
        .filter((entry) => entry !== undefined && entry.agent === agent)
        .reverse();
}
//# sourceMappingURL=run-history.js.map