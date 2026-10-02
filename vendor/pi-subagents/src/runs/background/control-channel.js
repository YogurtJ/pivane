/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs use a detached runner process. Unix detaches it from the parent process.
 * The original control path delivered an interrupt with
 * `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
 * deliver those signals cross-process via `process.kill` and throws `ENOSYS`,
 * which left async runs uninterruptible (no stop, no live steer) on Windows.
 *
 * This module adds a portable, file-based control inbox inside the run directory.
 * The parent drops an interrupt request file; the runner watches the inbox and
 * routes the request into its existing graceful `interruptRunner()` (pause +
 * resumable), identically on every platform. The file inbox is authoritative and
 * avoids signaling a PID that the extension cannot prove belongs to the runner.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { POLL_INTERVAL_MS } from "../../shared/types.js";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.js";
import { resolveWatchPath } from "../../shared/utils.js";
function writeJsonToExistingDir(filePath, payload) {
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`);
    try {
        fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: "utf-8", flag: "wx" });
        fs.renameSync(tempPath, filePath);
    }
    finally {
        fs.rmSync(tempPath, { force: true });
    }
}
const CONTROL_SAFETY_POLL_INTERVAL_MS = 5000;
const STEER_REQUESTS_DIR = "steer-requests";
const STOP_REQUESTS_DIR = "stop-requests";
const REVIVAL_BRIEFS_DIR = "revival-briefs";
export const MAX_STEER_QUEUE_SIZE = 20;
const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
const STOP_INBOX_CLOSED_FILE = "stop-inbox-closed.json";
const STOP_INBOX_CLOSED_MESSAGE = "Runner stop inbox is closed. Retry stop after runner shutdown is observed.";
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;
const MAX_STEER_REQUEST_ID_LENGTH = 256;
/** Control inbox directory inside an async run dir. */
export function controlInboxDir(asyncDir) {
    return path.join(asyncDir, "control");
}
/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), "interrupt.json");
}
/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), "timeout.json");
}
/** Path of the portable manual stop request file. */
export function stopRequestPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), "stop.json");
}
/** Directory of parent-to-runner stop requests. */
export function stopRequestsDir(asyncDir) {
    return path.join(controlInboxDir(asyncDir), STOP_REQUESTS_DIR);
}
/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir) {
    return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}
export function steerInboxClosedPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}
export function stopInboxClosedPath(asyncDir) {
    return path.join(controlInboxDir(asyncDir), STOP_INBOX_CLOSED_FILE);
}
export function closeStopInbox(asyncDir) {
    writeAtomicJson(stopInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now() });
}
export function closeSteerInbox(asyncDir, state, write = writeAtomicJson) {
    write(steerInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now(), state });
}
function assertChildIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index > 1_000_000)
        throw new Error("child index must be a non-negative integer.");
}
function validStopChildId(childId) {
    return typeof childId === "string"
        && Boolean(childId.trim())
        && childId.length <= 256
        && !/[\r\n]/.test(childId);
}
function steerRequestFileName(request) {
    return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}
function stopRequestFileName(request) {
    return `${String(request.ts ?? 0).padStart(13, "0")}-${randomUUID()}.json`;
}
function validSteerRequest(request) {
    return request.type === "steer"
        && typeof request.id === "string"
        && /^[^\s]+$/.test(request.id)
        && request.id.length <= MAX_STEER_REQUEST_ID_LENGTH
        && typeof request.ts === "number"
        && Number.isFinite(request.ts)
        && request.ts > 0
        && typeof request.message === "string"
        && Boolean(request.message.trim())
        && Buffer.byteLength(request.message, "utf8") <= MAX_STEER_MESSAGE_BYTES
        && (request.mode === undefined || request.mode === "steer" || request.mode === "follow_up" || request.mode === "auto")
        && (request.targetIndex === undefined || (Number.isInteger(request.targetIndex) && request.targetIndex >= 0 && request.targetIndex <= 1_000_000))
        && (request.targetIndexes === undefined || (request.targetIndex === undefined
            && Array.isArray(request.targetIndexes)
            && request.targetIndexes.length > 0
            && request.targetIndexes.length <= 1_000
            && request.targetIndexes.every((index) => Number.isInteger(index) && index >= 0 && index <= 1_000_000)
            && new Set(request.targetIndexes).size === request.targetIndexes.length))
        && (request.source === undefined || (typeof request.source === "string" && Boolean(request.source.trim()) && request.source.length <= 256));
}
export function writeSteerRequestToDir(dir, request) {
    if (!validSteerRequest(request))
        throw new Error("steer request is malformed or exceeds transport limits.");
    const requestPath = path.join(dir, steerRequestFileName(request));
    writeAtomicJson(requestPath, request);
    return requestPath;
}
export function writeSteerRequestToExistingDir(dir, request) {
    if (!validSteerRequest(request))
        throw new Error("steer request is malformed or exceeds transport limits.");
    const requestPath = path.join(dir, steerRequestFileName(request));
    writeJsonToExistingDir(requestPath, request);
    return requestPath;
}
/**
 * Parent side: drop a portable interrupt request the runner's inbox watcher will
 * pick up regardless of OS. Written atomically (temp + rename), dir auto-created.
 */
export function requestAsyncInterrupt(asyncDir, payload = {}, deps = {}) {
    const requestPath = interruptRequestPath(asyncDir);
    const request = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "interrupt" };
    writeAtomicJson(requestPath, request);
    return requestPath;
}
export function requestAsyncTimeout(asyncDir, payload = {}, deps = {}) {
    const requestPath = timeoutRequestPath(asyncDir);
    const request = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "timeout" };
    writeAtomicJson(requestPath, request);
    return requestPath;
}
export function requestAsyncStop(asyncDir, payload = {}, deps = {}) {
    if (payload.targetIndex !== undefined)
        assertChildIndex(payload.targetIndex);
    if (payload.childId !== undefined && !validStopChildId(payload.childId)) {
        throw new Error("stop childId must be a non-empty string without newlines and at most 256 characters.");
    }
    const closedPath = stopInboxClosedPath(asyncDir);
    if (fs.existsSync(closedPath))
        throw new Error(STOP_INBOX_CLOSED_MESSAGE);
    const request = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "stop" };
    const requestPath = path.join(stopRequestsDir(asyncDir), stopRequestFileName(request));
    (deps.write ?? writeAtomicJson)(requestPath, request);
    if (fs.existsSync(closedPath)) {
        fs.rmSync(requestPath, { force: true });
        throw new Error(STOP_INBOX_CLOSED_MESSAGE);
    }
    return requestPath;
}
export function requestAsyncSteer(asyncDir, payload, deps = {}) {
    const message = payload.message.trim();
    if (!message)
        throw new Error("steer message must not be empty.");
    if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES)
        throw new Error(`steer message exceeds ${MAX_STEER_MESSAGE_BYTES} UTF-8 bytes.`);
    if (payload.targetIndex !== undefined && (!Number.isInteger(payload.targetIndex) || payload.targetIndex < 0 || payload.targetIndex > 1_000_000)) {
        throw new Error("steer targetIndex must be an integer between 0 and 1000000.");
    }
    if (payload.targetIndexes !== undefined && (!Array.isArray(payload.targetIndexes)
        || payload.targetIndex !== undefined
        || payload.targetIndexes.length === 0
        || payload.targetIndexes.length > 1_000
        || payload.targetIndexes.some((index) => !Number.isInteger(index) || index < 0 || index > 1_000_000)
        || new Set(payload.targetIndexes).size !== payload.targetIndexes.length)) {
        throw new Error("steer targetIndexes must contain 1-1000 unique non-negative integers and cannot be combined with targetIndex.");
    }
    const closedPath = steerInboxClosedPath(asyncDir);
    if (fs.existsSync(closedPath))
        throw new Error("Async run no longer accepts steering requests.");
    const request = {
        type: "steer",
        id: payload.id ?? deps.randomId?.() ?? randomUUID(),
        ts: payload.ts ?? deps.now?.() ?? Date.now(),
        message,
        ...(payload.mode && payload.mode !== "steer" ? { mode: payload.mode } : {}),
        ...(payload.targetIndex !== undefined ? { targetIndex: payload.targetIndex } : {}),
        ...(payload.targetIndexes !== undefined ? { targetIndexes: [...payload.targetIndexes] } : {}),
        ...(payload.source ? { source: payload.source } : {}),
    };
    const requestPath = writeSteerRequestToDir(steerRequestsDir(asyncDir), request);
    if (fs.existsSync(closedPath)) {
        fs.rmSync(requestPath, { force: true });
        throw new Error("Async run stopped accepting steering before the request was committed.");
    }
    return requestPath;
}
function parseSteerRequest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const input = raw;
    if (!validSteerRequest(input))
        return undefined;
    return {
        type: "steer",
        id: input.id.trim(),
        ts: input.ts,
        message: input.message.trim(),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}),
        ...(input.targetIndexes !== undefined ? { targetIndexes: [...input.targetIndexes] } : {}),
        ...(typeof input.source === "string" && input.source.trim() ? { source: input.source } : {}),
    };
}
export function consumeSteerRequestsFromDir(dir, fsImpl = fs, onError = () => { }) {
    let entries;
    try {
        entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    }
    catch (error) {
        // Leave requests in place so the periodic poll can retry the scan.
        if (error.code !== "ENOENT")
            onError(error);
        return [];
    }
    const requests = [];
    for (const entry of entries) {
        const requestPath = path.join(dir, entry);
        let parsed;
        let text;
        try {
            text = fsImpl.readFileSync(requestPath, "utf-8");
        }
        catch (error) {
            if (error.code !== "ENOENT")
                onError(error);
            continue;
        }
        try {
            parsed = parseSteerRequest(JSON.parse(text));
        }
        catch {
            parsed = undefined;
        }
        try {
            fsImpl.rmSync(requestPath, { recursive: true });
        }
        catch (error) {
            // Already removed by a concurrent check — do not execute it twice.
            if (error.code !== "ENOENT")
                onError(error);
            continue;
        }
        if (parsed)
            requests.push(parsed);
    }
    return requests.sort((left, right) => left.ts - right.ts || left.id.localeCompare(right.id));
}
export function consumeSteerRequests(asyncDir, fsImpl = fs, onError) {
    return consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, onError);
}
export function queueRevivalBrief(asyncDir, request) {
    const dir = path.join(controlInboxDir(asyncDir), REVIVAL_BRIEFS_DIR);
    const queued = fs.existsSync(dir) ? fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).length : 0;
    if (queued >= MAX_STEER_QUEUE_SIZE)
        throw new Error(`Follow-up queue is full (${MAX_STEER_QUEUE_SIZE} messages).`);
    return writeSteerRequestToDir(dir, { ...request, mode: "follow_up" });
}
export function readRevivalBriefs(asyncDir) {
    const dir = path.join(controlInboxDir(asyncDir), REVIVAL_BRIEFS_DIR);
    if (!fs.existsSync(dir))
        return [];
    return fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort().flatMap((entry) => {
        const filePath = path.join(dir, entry);
        try {
            const request = parseSteerRequest(JSON.parse(fs.readFileSync(filePath, "utf-8")));
            return request ? [{ request, path: filePath }] : [];
        }
        catch {
            return [];
        }
    });
}
/**
 * Runner side: consume a pending interrupt request. Idempotent — removes the file
 * so each distinct request fires exactly once. Returns whether one was pending.
 */
export function consumeInterruptRequest(asyncDir, fsImpl = fs) {
    const requestPath = interruptRequestPath(asyncDir);
    if (!fsImpl.existsSync(requestPath))
        return false;
    try {
        fsImpl.rmSync(requestPath, { force: true, recursive: true });
    }
    catch {
        // Already removed by a concurrent check — still counts as consumed.
    }
    return true;
}
export function consumeTimeoutRequest(asyncDir, fsImpl = fs) {
    const requestPath = timeoutRequestPath(asyncDir);
    if (!fsImpl.existsSync(requestPath))
        return false;
    try {
        fsImpl.rmSync(requestPath, { force: true, recursive: true });
    }
    catch {
        // Already removed by a concurrent check — still counts as consumed.
    }
    return true;
}
export function consumeStopRequest(asyncDir, fsImpl = fs) {
    return consumeStopRequestPayload(asyncDir, fsImpl) !== undefined;
}
function parseStopRequest(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        return undefined;
    const parsed = raw;
    if (parsed.type !== "stop")
        return undefined;
    if (Object.hasOwn(parsed, "targetIndex") && !(Number.isInteger(parsed.targetIndex) && parsed.targetIndex >= 0 && parsed.targetIndex <= 1_000_000))
        return undefined;
    if (Object.hasOwn(parsed, "childId") && !validStopChildId(parsed.childId))
        return undefined;
    return {
        type: "stop",
        ...(typeof parsed.ts === "number" ? { ts: parsed.ts } : {}),
        ...(typeof parsed.source === "string" ? { source: parsed.source } : {}),
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason } : {}),
        ...(parsed.targetIndex !== undefined ? { targetIndex: parsed.targetIndex } : {}),
        ...(validStopChildId(parsed.childId) ? { childId: parsed.childId } : {}),
    };
}
function consumeStopRequestFile(requestPath, fsImpl, onError) {
    let text;
    try {
        text = fsImpl.readFileSync(requestPath, "utf-8");
    }
    catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            onError?.(error);
        return undefined;
    }
    let request;
    try {
        request = parseStopRequest(JSON.parse(text));
    }
    catch {
        request = undefined;
    }
    try {
        fsImpl.rmSync(requestPath, { force: true, recursive: true });
    }
    catch (error) {
        // Execute only after successful removal.
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
            onError?.(error);
        return undefined;
    }
    return request;
}
export function consumeStopRequestPayloads(asyncDir, fsImpl = fs, onError) {
    const dir = stopRequestsDir(asyncDir);
    const requests = [];
    if (fsImpl.existsSync(dir)) {
        let entries;
        try {
            entries = fsImpl.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
        }
        catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
                onError?.(error);
            entries = [];
        }
        for (const entry of entries) {
            const request = consumeStopRequestFile(path.join(dir, entry), fsImpl, onError);
            if (request)
                requests.push(request);
        }
    }
    const legacyPath = stopRequestPath(asyncDir);
    if (fsImpl.existsSync(legacyPath)) {
        const request = consumeStopRequestFile(legacyPath, fsImpl, onError);
        if (request)
            requests.push(request);
    }
    return requests.sort((left, right) => (left.ts ?? 0) - (right.ts ?? 0));
}
export function consumeStopRequestPayload(asyncDir, fsImpl = fs) {
    return consumeStopRequestPayloads(asyncDir, fsImpl)[0];
}
/** Parent side: write the authoritative portable interrupt request. */
export function deliverInterruptRequest(input) {
    requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}
export function deliverTimeoutRequest(input) {
    requestAsyncTimeout(input.asyncDir, input.source ? { source: input.source } : {}, { now: input.now });
}
export function deliverStopRequest(input) {
    requestAsyncStop(input.asyncDir, { ...(input.source ? { source: input.source } : {}), ...(input.targetIndex !== undefined ? { targetIndex: input.targetIndex } : {}), ...(input.childId ? { childId: input.childId } : {}) }, { now: input.now });
}
/**
 * Active owner: watch and consume only kinds with installed handlers.
 * Uses `fs.watch` when available and starts interval polling
 * only when native watching is unavailable or fails. Fires once per distinct
 * request. Returns a disposer.
 */
export function watchAsyncControlInbox(asyncDir, opts) {
    const fsImpl = opts.fs ?? fs;
    const timers = opts.timers ?? { setInterval, clearInterval };
    const dir = controlInboxDir(asyncDir);
    const report = (error, phase, request) => {
        try {
            if (opts.onError)
                opts.onError(error, phase, request);
            else
                console.error(`Control inbox ${phase} failed:`, error);
        }
        catch (reportError) {
            console.error("Control inbox error reporter failed:", reportError);
        }
    };
    const dirs = [
        ...(opts.onInterrupt || opts.onTimeout || opts.onStop ? [dir] : []),
        ...(opts.onStop ? [stopRequestsDir(asyncDir)] : []),
        ...(opts.onSteer ? [steerRequestsDir(asyncDir)] : []),
    ];
    if (dirs.length === 0)
        return () => { };
    try {
        for (const target of dirs)
            fsImpl.mkdirSync(target, { recursive: true });
    }
    catch (error) {
        report(error, "install");
    }
    let disposed = false;
    const check = () => {
        if (disposed)
            return;
        try {
            if (opts.onStop)
                for (const request of consumeStopRequestPayloads(asyncDir, fsImpl, (error) => report(error, "scan"))) {
                    try {
                        opts.onStop(request);
                    }
                    catch (error) {
                        report(error, "callback");
                    }
                }
            if (opts.onTimeout && consumeTimeoutRequest(asyncDir, fsImpl)) {
                try {
                    opts.onTimeout();
                }
                catch (error) {
                    report(error, "callback");
                }
            }
            if (opts.onInterrupt && consumeInterruptRequest(asyncDir, fsImpl)) {
                try {
                    opts.onInterrupt();
                }
                catch (error) {
                    report(error, "callback");
                }
            }
            if (opts.onSteer)
                for (const request of consumeSteerRequestsFromDir(steerRequestsDir(asyncDir), fsImpl, (error) => report(error, "scan"))) {
                    try {
                        opts.onSteer(request);
                    }
                    catch (error) {
                        report(error, "callback", request);
                    }
                }
        }
        catch (error) {
            report(error, "scan");
        }
    };
    // Handle a request that may have arrived before the watcher started.
    check();
    const watchers = [];
    let interval;
    let safetyInterval;
    const startPolling = () => {
        if (interval || disposed)
            return;
        if (safetyInterval) {
            timers.clearInterval(safetyInterval);
            safetyInterval = undefined;
        }
        interval = timers.setInterval(check, opts.pollIntervalMs ?? POLL_INTERVAL_MS);
        interval.unref?.();
    };
    try {
        if (shouldUseNativeFsWatch("runner-control-inbox", opts.platform)) {
            for (const target of dirs) {
                const watcher = fsImpl.watch(resolveWatchPath(target, fsImpl.realpathSync.native), check);
                watcher.on?.("error", startPolling);
                watchers.push(watcher);
            }
            if (!interval) {
                safetyInterval = timers.setInterval(check, opts.safetyPollIntervalMs ?? CONTROL_SAFETY_POLL_INTERVAL_MS);
                safetyInterval.unref?.();
            }
        }
        else {
            startPolling();
        }
    }
    catch {
        startPolling();
    }
    return () => {
        if (disposed)
            return;
        disposed = true;
        for (const watcher of watchers) {
            try {
                watcher.close();
            }
            catch {
                // ignore
            }
        }
        if (interval)
            timers.clearInterval(interval);
        if (safetyInterval)
            timers.clearInterval(safetyInterval);
    };
}
//# sourceMappingURL=control-channel.js.map