import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { tryLease } from "../../shared/file-lease.js";
export function withHandoffWriteLock(manifestPath, action) {
    const requested = path.resolve(manifestPath);
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    const absolute = path.join(fs.realpathSync.native(path.dirname(requested)), path.basename(requested));
    const release = tryLease(`${absolute}.write-lock`);
    if (!release)
        throw new Error(`Handoff is being updated or cleaned: ${absolute}. Retry after the current operation completes.`);
    try {
        return action();
    }
    finally {
        release();
    }
}
export async function withRepositoryWorktreeLock(repo, action, options = {}) {
    const git = spawnSync("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf-8", windowsHide: true });
    if (git.status !== 0)
        throw new Error(git.error?.message || git.stderr.trim() || "Cannot resolve Git common directory.");
    const lockPath = path.join(fs.realpathSync(git.stdout.trim()), "pi-subagents-worktree.lock");
    const deadline = Date.now() + (options.waitMs ?? 2_000);
    while (true) {
        options.signal?.throwIfAborted();
        const release = tryLease(lockPath);
        if (release) {
            try {
                return await action();
            }
            finally {
                release();
            }
        }
        if (Date.now() >= deadline)
            throw new Error("Repository worktree maintenance is busy; retry later.");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}
//# sourceMappingURL=worktree-lock.js.map