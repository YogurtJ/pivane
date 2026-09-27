import type { AsyncStatus } from "../../shared/types.ts";
import type { RunnerStep } from "../shared/parallel-utils.ts";
export interface ChainAppendRequest {
    id: string;
    createdAt: number;
    steps: RunnerStep[];
}
export interface ChainAppendResult {
    request: ChainAppendRequest;
    pendingCount: number;
    bookkeepingError?: string;
}
export declare function countPendingChainAppendRequests(asyncDir: string): number;
export declare function runnerStepOutputNames(steps: RunnerStep[]): string[];
export declare function enqueueChainAppendRequest(input: {
    asyncDir: string;
    runId: string;
    steps: RunnerStep[];
    now?: number;
    admit?: (persist: () => void) => void;
}): ChainAppendResult;
export declare function readPendingChainAppendRequests(asyncDir: string): ChainAppendRequest[];
export declare function consumeChainAppendRequests(asyncDir: string): ChainAppendRequest[];
/** Bounded one-line per-step task description persisted into status.json for fleet display. */
export declare function statusStepDescription(task: string | undefined): string | undefined;
export declare function appendRunnerStepsToStatus(input: {
    status: AsyncStatus;
    steps: RunnerStep[];
    now?: number;
    pendingAppends?: number;
}): {
    addedChainSteps: number;
    addedFlatSteps: number;
};
//# sourceMappingURL=chain-append.d.ts.map