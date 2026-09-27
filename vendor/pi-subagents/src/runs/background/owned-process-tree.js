import { spawnSync } from "node:child_process";
const DEFAULT_TERM_GRACE_MS = 3000;
const DEFAULT_KILL_VERIFY_MS = 1000;
const VERIFY_INTERVAL_MS = 25;
function diagnostic(error) {
    return error instanceof Error ? error.message : String(error);
}
function signalProcess(id, signal) {
    try {
        process.kill(id, signal);
        return "sent";
    }
    catch (error) {
        if (error.code === "ESRCH")
            return "absent";
        return { diagnostic: diagnostic(error) };
    }
}
function activeProcessGroupMembers(processGroupId) {
    const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf-8" });
    if (result.error || result.status !== 0) {
        return { diagnostic: result.error ? diagnostic(result.error) : (result.stderr.trim() || `ps exited with ${result.status}`) };
    }
    const members = [];
    for (const line of result.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        if (!match || Number(match[2]) !== processGroupId || match[3].startsWith("Z"))
            continue;
        members.push(Number(match[1]));
    }
    return members;
}
function knownDetachedDescendants(processGroupId) {
    const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat="], { encoding: "utf-8" });
    if (result.error || result.status !== 0)
        return [];
    const owned = new Set();
    const outside = [];
    for (const line of result.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
        if (!match || match[4].startsWith("Z"))
            continue;
        const pid = Number(match[1]);
        const ppid = Number(match[2]);
        const pgid = Number(match[3]);
        if (pgid === processGroupId)
            owned.add(pid);
        else
            outside.push({ pid, ppid });
    }
    return outside.filter((row) => owned.has(row.ppid)).map((row) => row.pid);
}
async function waitUntilGroupTerminal(processGroupId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
        const members = activeProcessGroupMembers(processGroupId);
        if (Array.isArray(members) && members.length === 0)
            return false;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
            if (!Array.isArray(members))
                return { state: "enumeration-failed", diagnostic: members.diagnostic };
            return { state: "still-active", diagnostic: `Process group ${processGroupId} still has active members: ${members.join(", ")}.` };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(VERIFY_INTERVAL_MS, remaining)));
    }
}
function observed(processGroupId) {
    return { state: "observed", mechanism: "posix-process-group", processGroupId, verifiedAt: Date.now() };
}
function observedUnlessLiveDetached(processGroupId, detached) {
    const live = detached.filter((pid) => {
        const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf-8" });
        return result.status === 0 && Boolean(result.stdout.trim()) && !result.stdout.trim().startsWith("Z");
    });
    if (live.length === 0)
        return observed(processGroupId);
    return { state: "unknown", reason: "verification-failed", diagnostic: `Owned detached descendant(s) still active: ${live.join(", ")}.` };
}
export function createOwnedProcessTreeController(pid, options = {}) {
    let termination;
    const posixGroupOwned = process.platform !== "win32";
    const target = posixGroupOwned ? -pid : pid;
    const terminate = () => {
        if (termination)
            return termination;
        termination = (async () => {
            if (!posixGroupOwned) {
                signalProcess(target, "SIGTERM");
                return { state: "unknown", reason: "unsupported-platform" };
            }
            const detached = knownDetachedDescendants(pid);
            const term = signalProcess(target, "SIGTERM");
            if (term !== "sent" && term !== "absent") {
                return { state: "unknown", reason: "signal-failed", diagnostic: term.diagnostic };
            }
            const termExit = await waitUntilGroupTerminal(pid, options.termGraceMs ?? DEFAULT_TERM_GRACE_MS);
            if (termExit === false)
                return observedUnlessLiveDetached(pid, detached);
            const kill = signalProcess(target, "SIGKILL");
            if (kill !== "sent" && kill !== "absent") {
                const members = activeProcessGroupMembers(pid);
                if (!Array.isArray(members) || members.length > 0) {
                    return { state: "unknown", reason: "signal-failed", diagnostic: kill.diagnostic };
                }
            }
            const killExit = await waitUntilGroupTerminal(pid, options.killVerifyMs ?? DEFAULT_KILL_VERIFY_MS);
            if (killExit !== false) {
                return { state: "unknown", reason: "verification-failed", diagnostic: killExit.diagnostic };
            }
            return observedUnlessLiveDetached(pid, detached);
        })();
        return termination;
    };
    return { terminate, finishAfterWriterClose: terminate };
}
//# sourceMappingURL=owned-process-tree.js.map