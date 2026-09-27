import { snapshotBackgroundWork } from "../../api/background-work.js";
import { listAsyncRuns } from "./async-status.js";
import { waitForSubagents, waitRunScopes } from "./subagent-wait.js";
export const DEFAULT_AUTO_DRAIN_TIMEOUT_MS = 30 * 60 * 1000;
function resultText(value) {
    return value.content.map((part) => part.type === "text" ? part.text : "").join(" ").trim();
}
function hasOutstandingWork(deps, sessionId, nowMs, observation) {
    const asyncRuns = waitRunScopes(deps).flatMap(({ asyncDirRoot, resultsDir }) => listAsyncRuns(asyncDirRoot, {
        states: ["queued", "running"],
        sessionId,
        resultsDir,
        now: () => nowMs,
        includeNested: false,
    }, observation?.status));
    const detachedForeground = [...(deps.state.foregroundRuns?.values() ?? [])].some((run) => run.sessionId === sessionId && run.children.some((child) => child.status === "detached"));
    return asyncRuns.length > 0 || snapshotBackgroundWork(sessionId, nowMs).items.length > 0 || detachedForeground;
}
/** Drain all work owned by the current headless session, including work added while draining. */
export async function drainOutstandingWork(deps, observation) {
    const sessionId = deps.state.currentSessionId;
    observation?.begin(sessionId, !deps.hasWork && !deps.wait && !deps.now && !deps.hasPendingSupervisorRequest);
    try {
        if (!sessionId)
            throw new Error("Cannot auto-drain background work without an active session identity.");
        const now = deps.now ?? Date.now;
        const timeoutMs = deps.timeoutMs ?? DEFAULT_AUTO_DRAIN_TIMEOUT_MS;
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
            throw new Error("Auto-drain timeoutMs must be a positive finite number.");
        const deadlineAt = now() + timeoutMs;
        const hasWork = deps.hasWork ?? ((id, time) => hasOutstandingWork(deps, id, time, observation));
        const wait = deps.wait ?? waitForSubagents;
        while (true) {
            if (deps.state.currentSessionId !== sessionId)
                throw new Error("Auto-drain stopped because the active session changed.");
            if (deps.hasPendingSupervisorRequest?.())
                break;
            const work = hasWork(sessionId, now());
            observation?.predicate(work);
            if (!work)
                break;
            const remainingMs = deadlineAt - now();
            if (remainingMs <= 0) {
                throw new Error(`Auto-drain timed out after ${timeoutMs}ms with background work still active in session '${sessionId}'.`);
            }
            const waitResult = await wait({ all: true, timeoutMs: remainingMs }, undefined, {
                state: deps.state,
                asyncDirRoot: deps.asyncDirRoot,
                resultsDir: deps.resultsDir,
                nestedRootRunId: deps.nestedRootRunId,
                events: deps.events,
                now,
                stopOnAttention: false,
                failOnFailedRuns: true,
                failOnAttention: true,
                hasPendingSupervisorRequest: deps.hasPendingSupervisorRequest,
            });
            if (waitResult.isError) {
                throw new Error(`Auto-drain failed for session '${sessionId}': ${resultText(waitResult) || "bg_wait returned an error without details"}.`);
            }
            if (waitResult.details.wait?.reason === "supervisor_request")
                break;
            if (deps.hasPendingSupervisorRequest?.())
                break;
        }
        observation?.complete();
    }
    catch (error) {
        observation?.deny();
        throw error;
    }
}
//# sourceMappingURL=auto-drain.js.map