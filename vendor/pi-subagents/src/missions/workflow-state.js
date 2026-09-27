import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.js";
import { DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS, isRetryableFileSystemError, waitForFileSystemRetry } from "../shared/file-system-retry.js";
import { assertWorkflowJsonValue } from "../workflows/scripted-workflow.js";
import { validateMissionId } from "./store.js";
const STATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_LOCK_STALE_MS = 60_000;
export const MISSION_STATE_MAX_BYTES = 256 * 1024;
export function missionStatePath(location, missionId) {
    return path.join(location.missionDir, validateMissionId(missionId), "state.json");
}
function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function linuxProcessStartKey(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
        const tail = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
        return tail[19] ? `linux:${tail[19]}` : undefined;
    }
    catch {
        return undefined;
    }
}
function psProcessStartKey(pid) {
    try {
        const raw = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000 }).trim();
        return raw ? `ps:${raw}` : undefined;
    }
    catch {
        return undefined;
    }
}
function windowsProcessStartKey(pid) {
    try {
        const raw = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CreationDate`], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 1000, windowsHide: true }).trim();
        return raw ? `win:${raw}` : undefined;
    }
    catch {
        return undefined;
    }
}
let currentProcessKey = null;
function processStartKey(pid) {
    // Foreign PIDs can be reused while this process lives, so resolve them afresh.
    if (pid !== process.pid)
        return computeProcessStartKey(pid);
    if (currentProcessKey === null)
        currentProcessKey = computeProcessStartKey(pid);
    return currentProcessKey;
}
function computeProcessStartKey(pid) {
    if (process.platform === "linux")
        return linuxProcessStartKey(pid) ?? psProcessStartKey(pid);
    if (process.platform === "win32")
        return windowsProcessStartKey(pid);
    return undefined;
}
function readStateLockOwner(lockPath) {
    try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"));
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string" && owner.token && Number.isSafeInteger(owner.createdAt)) {
            return {
                pid: owner.pid,
                token: owner.token,
                createdAt: owner.createdAt,
                ...(typeof owner.processKey === "string" && owner.processKey ? { processKey: owner.processKey } : {}),
            };
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
function stateLockIsStale(lockPath, options, now = Date.now()) {
    const owner = readStateLockOwner(lockPath);
    if (owner) {
        if (!options.isProcessAlive(owner.pid))
            return true;
        if (owner.processKey) {
            const observedProcessKey = options.getProcessStartKey(owner.pid);
            if (observedProcessKey)
                return owner.processKey !== observedProcessKey;
            if (owner.pid === process.pid)
                return true;
        }
        return false;
    }
    try {
        return now - fs.statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function removeOwnedStateLock(lockPath, owner) {
    const current = readStateLockOwner(lockPath);
    if (current?.token !== owner.token)
        return;
    fs.rmSync(lockPath, { recursive: true, force: true });
}
function staleDirectoryExists(dirPath, now = Date.now()) {
    try {
        return now - fs.statSync(dirPath).mtimeMs > STATE_LOCK_STALE_MS;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return false;
        throw error;
    }
}
function tryMakeDirectory(dirPath, mode) {
    try {
        fs.mkdirSync(dirPath, { mode });
        return true;
    }
    catch (error) {
        if (error.code === "EEXIST")
            return false;
        throw error;
    }
}
function waitForStateLock(delayMs, lockPath) {
    if (delayMs === undefined)
        throw new Error(`Timed out acquiring mission state lock '${lockPath}'.`);
    waitForFileSystemRetry(delayMs);
}
function reclaimStaleStateLock(lockPath, reclaimPath, options) {
    if (!stateLockIsStale(lockPath, options))
        return false;
    if (!tryMakeDirectory(reclaimPath, 0o700))
        return false;
    try {
        if (!stateLockIsStale(lockPath, options))
            return false;
        fs.rmSync(lockPath, { recursive: true, force: true });
        return true;
    }
    finally {
        fs.rmSync(reclaimPath, { recursive: true, force: true });
    }
}
function withStateFileLock(filePath, operation, options) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const lockPath = `${filePath}.lock`;
    const reclaimPath = `${lockPath}.reclaim`;
    let owner;
    for (let attempt = 0;; attempt++) {
        if (fs.existsSync(reclaimPath)) {
            if (staleDirectoryExists(reclaimPath)) {
                fs.rmSync(reclaimPath, { recursive: true, force: true });
                continue;
            }
            waitForStateLock(options.retryDelaysMs[attempt], lockPath);
            continue;
        }
        let acquired = false;
        try {
            acquired = tryMakeDirectory(lockPath, 0o700);
        }
        catch (error) {
            if (isRetryableFileSystemError(error)) {
                waitForStateLock(options.retryDelaysMs[attempt], lockPath);
                continue;
            }
            throw new Error(`Failed to acquire mission state lock '${lockPath}': ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!acquired) {
            if (reclaimStaleStateLock(lockPath, reclaimPath, options))
                continue;
            waitForStateLock(options.retryDelaysMs[attempt], lockPath);
            continue;
        }
        const key = options.getProcessStartKey(process.pid);
        owner = { pid: process.pid, token: randomUUID(), createdAt: Date.now(), ...(key ? { processKey: key } : {}) };
        try {
            fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { encoding: "utf-8", mode: 0o600 });
        }
        catch (error) {
            fs.rmSync(lockPath, { recursive: true, force: true });
            owner = undefined;
            throw error;
        }
        break;
    }
    try {
        return operation();
    }
    finally {
        if (owner)
            removeOwnedStateLock(lockPath, owner);
    }
}
function validateStateKey(value) {
    if (typeof value !== "string" || !STATE_KEY_PATTERN.test(value)) {
        throw new Error("state key must be 1-128 characters using letters, numbers, '.', '_' or '-', and start with a letter or number.");
    }
    return value;
}
export function createMissionWorkflowState(location, missionId, options = {}) {
    const filePath = missionStatePath(location, missionId);
    const lockOptions = {
        isProcessAlive: options.isProcessAlive ?? isProcessAlive,
        getProcessStartKey: options.getProcessStartKey ?? processStartKey,
        retryDelaysMs: options.retryDelaysMs ?? DEFAULT_FILE_SYSTEM_RETRY_DELAYS_MS,
    };
    let loaded = false;
    let values = Object.create(null);
    const readStateFile = () => {
        let raw;
        try {
            raw = fs.readFileSync(filePath, "utf-8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return Object.create(null);
            throw new Error(`Failed to read mission state '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
        }
        const bytes = Buffer.byteLength(raw);
        if (bytes > MISSION_STATE_MAX_BYTES)
            throw new Error(`Mission state file '${filePath}' exceeds the 256 KiB limit (${bytes} bytes).`);
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("root must be a JSON object");
            assertWorkflowJsonValue(parsed, "mission state");
            return Object.assign(Object.create(null), parsed);
        }
        catch (error) {
            throw new Error(`Invalid mission state file '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
        }
    };
    const load = () => {
        if (loaded)
            return values;
        values = readStateFile();
        loaded = true;
        return values;
    };
    return {
        path: filePath,
        get(key) {
            const validKey = validateStateKey(key);
            const current = load();
            return Object.hasOwn(current, validKey) ? current[validKey] : undefined;
        },
        set(key, value) {
            const validKey = validateStateKey(key);
            assertWorkflowJsonValue(value, `state.set('${validKey}') value`);
            withStateFileLock(filePath, () => {
                const next = Object.assign(Object.create(null), readStateFile(), { [validKey]: value });
                const bytes = Buffer.byteLength(JSON.stringify(next, null, 2));
                if (bytes > MISSION_STATE_MAX_BYTES)
                    throw new Error(`Mission state exceeds the 256 KiB limit (${bytes} bytes; maximum ${MISSION_STATE_MAX_BYTES} bytes).`);
                writePrivateAtomicJson(filePath, next);
                values = next;
                loaded = true;
            }, lockOptions);
        },
    };
}
//# sourceMappingURL=workflow-state.js.map