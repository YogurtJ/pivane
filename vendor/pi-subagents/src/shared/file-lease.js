import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { waitForFileSystemRetry } from "./file-system-retry.js";
function startIdentity(pid) {
    if (process.platform !== "linux")
        return undefined;
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
        return raw.slice(raw.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
    }
    catch {
        return undefined;
    }
}
function readOwner(lockPath) {
    try {
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, "owner.json"), "utf-8"));
        if ((typeof owner.token !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(owner.token)) || typeof owner.hostname !== "string" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0)
            return undefined;
        return owner;
    }
    catch {
        return undefined;
    }
}
function deadOwner(owner) {
    if (owner.hostname !== os.hostname())
        return false;
    try {
        process.kill(owner.pid, 0);
    }
    catch (error) {
        return error.code === "ESRCH";
    }
    const current = startIdentity(owner.pid);
    return owner.processStart !== undefined && current !== undefined && owner.processStart !== current;
}
/** Unknown owners and live processes are never evicted merely because a lock is old. */
export function tryLease(lockPath) {
    const owner = { token: randomUUID(), pid: process.pid, hostname: os.hostname(), processStart: startIdentity(process.pid) };
    try {
        fs.mkdirSync(lockPath, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== "EEXIST")
            throw error;
        const previous = readOwner(lockPath);
        if (!previous || !deadOwner(previous))
            return undefined;
        // Retain the nonempty old directory as a fence: a delayed reclaimer of
        // this token cannot rename a replacement lease over that destination.
        const retired = `${lockPath}.retired-${previous.token}`;
        try {
            fs.renameSync(lockPath, retired);
        }
        catch (error) {
            if (error.code === "ENOENT" || readOwner(retired)?.token === previous.token)
                return undefined;
            throw error;
        }
        if (readOwner(retired)?.token !== previous.token)
            throw new Error(`Retired lock owner changed during recovery: ${lockPath}`);
        return tryLease(lockPath);
    }
    try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    }
    catch (error) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
    }
    return () => {
        if (readOwner(lockPath)?.token === owner.token)
            fs.rmSync(lockPath, { recursive: true });
    };
}
/** Hold a lease beside `filePath` for a short synchronous update, waiting at most `waitMs` for another owner. */
export function withFileLease(filePath, action, waitMs = 200) {
    const requested = path.resolve(filePath);
    const absolute = path.join(fs.realpathSync.native(path.dirname(requested)), path.basename(requested));
    const lockPath = `${absolute}.write-lock`;
    const deadline = performance.now() + waitMs;
    let release = tryLease(lockPath);
    while (!release) {
        const remaining = deadline - performance.now();
        if (remaining <= 0)
            throw new Error(`Timed out waiting for another process to finish updating ${absolute}.`);
        waitForFileSystemRetry(Math.min(10, remaining));
        release = tryLease(lockPath);
    }
    try {
        return action();
    }
    finally {
        release();
    }
}
//# sourceMappingURL=file-lease.js.map