import { type ActiveAsyncCapacitySnapshot } from "../../shared/types.ts";
import { type PidLiveness } from "./stale-run-reconciler.ts";
export declare const ACTIVE_ASYNC_CAPACITY_DIR: string;
export declare const DEFAULT_ABANDONED_SLOT_RELEASE_AFTER_MS: number;
export declare const MIN_ABANDONED_SLOT_RELEASE_AFTER_MS: number;
export declare const MAX_ABANDONED_SLOT_RELEASE_AFTER_MS: number;
export interface ActiveAsyncCapacityOwner {
    version: 1;
    reservationToken: string;
    ownerSessionId: string;
    ownerSessionKey: string;
    slot: number;
    runId: string;
    sourceRunId?: string;
    generation: number;
    kind: "runner" | "workflow";
    asyncDir: string;
    reservedAt: number;
    runnerProcessInstanceId?: string;
    runnerStartedAt?: number;
}
export interface ActiveAsyncCapacityHandle {
    readonly owner: ActiveAsyncCapacityOwner;
    markStarted(runnerProcessInstanceId: string): void;
    markWorkflowStarted(): void;
    rollback(): boolean;
    rollbackBeforeRunnerProceed(runnerProcessInstanceId: string): boolean;
    reconcile(liveWorkflowRunIds?: ReadonlySet<string>): ActiveAsyncCapacitySnapshot;
}
interface CapacityOptions {
    rootDir?: string;
    now?: () => number;
    token?: () => string;
    abandonedSlotReleaseAfterMs?: number | false;
    pidLiveness?: (pid: number) => PidLiveness;
    afterSlotRename?: (releasedDir: string) => void;
    writeOwner?: (filePath: string, owner: ActiveAsyncCapacityOwner) => void;
}
export interface ActiveAsyncCapacityReleaseEvidence {
    releasedBy: "abandoned-timeout";
    processProof: "unknown";
    runnerPid: "gone";
    lastActivityAgeMs: number;
    abandonedSlotReleaseAfterMs: number;
}
export type ActiveAsyncCapacityReleaseVerdict = {
    state: "releasable";
    reason: string;
    evidence?: ActiveAsyncCapacityReleaseEvidence;
} | {
    state: "retained";
    reason: string;
} | {
    state: "not-owned";
    reason: string;
};
export interface ActiveAsyncCapacityInspection {
    owner?: ActiveAsyncCapacityOwner;
    relation: "current" | "source" | "none";
    slotDir?: string;
    release: ActiveAsyncCapacityReleaseVerdict;
}
export declare class ActiveAsyncCapacityError extends Error {
    readonly snapshot: ActiveAsyncCapacitySnapshot;
    constructor(snapshot: ActiveAsyncCapacitySnapshot);
}
export declare function resolveMaxActiveAsyncRunsPerSession(value: unknown): number | undefined;
export declare function resolveAbandonedSlotReleaseAfterMs(value: unknown): number | false;
export declare function activeAsyncCapacitySessionKey(sessionId: string): string;
export declare function inspectActiveAsyncCapacityOwner(input: {
    runId: string;
    sessionId?: string;
    asyncDir?: string;
}, options?: CapacityOptions & {
    liveWorkflowRunIds?: ReadonlySet<string>;
}): ActiveAsyncCapacityInspection;
export declare function reconcileActiveAsyncCapacity(sessionId: string, limit: number | undefined, options?: CapacityOptions & {
    liveWorkflowRunIds?: ReadonlySet<string>;
}): ActiveAsyncCapacitySnapshot;
export declare function getActiveAsyncCapacitySnapshot(sessionId: string, limit: number | undefined, options?: CapacityOptions & {
    liveWorkflowRunIds?: ReadonlySet<string>;
}): ActiveAsyncCapacitySnapshot;
export declare function acquireActiveAsyncCapacity(input: {
    sessionId: string;
    limit: number | undefined;
    runId: string;
    kind: "runner" | "workflow";
    asyncDir: string;
}, options?: CapacityOptions & {
    liveWorkflowRunIds?: ReadonlySet<string>;
}): ActiveAsyncCapacityHandle | undefined;
export declare function transferActiveAsyncCapacity(input: {
    sessionId: string;
    limit: number | undefined;
    sourceRunId: string;
    runId: string;
    asyncDir: string;
}, options?: CapacityOptions): ActiveAsyncCapacityHandle | undefined;
export {};
//# sourceMappingURL=active-async-capacity.d.ts.map