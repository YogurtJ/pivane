import { projectAsyncStatusSnapshot as buildAsyncStatusSnapshot, } from "../shared/async-status-projection.js";
export { ASYNC_STATUS_SNAPSHOT_KIND, ASYNC_STATUS_SNAPSHOT_VERSION, } from "../shared/async-status-projection.js";
export const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
export { buildAsyncStatusSnapshot };
export function asyncStatusSnapshotJobsForState(state, sessionId) {
    if (!state || !sessionId || state.currentSessionId !== sessionId)
        return [];
    const jobs = new Map();
    for (const job of state.asyncJobs.values()) {
        if (job.sessionId === sessionId)
            jobs.set(job.asyncId, job);
    }
    for (const job of state.fleetJobs?.values() ?? []) {
        if (job.sessionId === sessionId && !jobs.has(job.asyncId))
            jobs.set(job.asyncId, job);
    }
    return [...jobs.values()];
}
export function buildAsyncStatusSnapshotForState(state, sessionId, options = {}) {
    return buildAsyncStatusSnapshot(asyncStatusSnapshotJobsForState(state, sessionId), options);
}
export function encodeAsyncStatusSnapshotWidget(jobs, options = {}) {
    return [`${ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX}${JSON.stringify(buildAsyncStatusSnapshot(jobs, options))}`];
}
//# sourceMappingURL=async-status-snapshot.js.map