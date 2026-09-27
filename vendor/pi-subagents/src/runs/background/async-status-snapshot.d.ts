import type { AsyncJobState, SubagentState } from "../../shared/types.ts";
import { projectAsyncStatusSnapshot as buildAsyncStatusSnapshot, type AsyncStatusSnapshotOptions, type AsyncStatusSnapshot } from "../shared/async-status-projection.ts";
export { ASYNC_STATUS_SNAPSHOT_KIND, ASYNC_STATUS_SNAPSHOT_VERSION, } from "../shared/async-status-projection.ts";
export type { AsyncStatusSnapshotActivity, AsyncStatusSnapshotCaps, AsyncStatusSnapshotHostStep, AsyncStatusSnapshotKind, AsyncStatusSnapshotNode, AsyncStatusSnapshotOmitted, AsyncStatusSnapshotOptions, AsyncStatusSnapshotState, AsyncStatusSnapshot, } from "../shared/async-status-projection.ts";
export declare const ASYNC_STATUS_SNAPSHOT_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
export { buildAsyncStatusSnapshot };
export declare function asyncStatusSnapshotJobsForState(state: SubagentState | undefined, sessionId: string | null | undefined): AsyncJobState[];
export declare function buildAsyncStatusSnapshotForState(state: SubagentState | undefined, sessionId: string | null | undefined, options?: AsyncStatusSnapshotOptions): AsyncStatusSnapshot;
export declare function encodeAsyncStatusSnapshotWidget(jobs: Iterable<AsyncJobState>, options?: AsyncStatusSnapshotOptions): string[];
//# sourceMappingURL=async-status-snapshot.d.ts.map