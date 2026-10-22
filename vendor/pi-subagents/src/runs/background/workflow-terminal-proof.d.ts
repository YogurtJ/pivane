import type { AsyncStatus, ProcessTerminal, WorkflowChildSummary, WorkflowTerminalProof } from "../../shared/types.ts";
export declare function isTerminalAsyncState(state: AsyncStatus["state"]): state is Exclude<AsyncStatus["state"], "queued" | "running" | "paused">;
/**
 * The model an async workflow child reports for itself. Workflow lane records keep only
 * launch identity, so display projections fall back to the child's own status step.
 */
export declare function readWorkflowChildRunModel(workflowAsyncDir: string, step: {
    async?: boolean;
    runId?: string;
}): {
    model?: string;
    thinking?: string;
} | undefined;
/** Fill a workflow child roster row from the child's own reported model. */
export declare function withWorkflowChildRunModel<T extends {
    runId?: string;
    model?: string;
    thinking?: string;
}>(workflowAsyncDir: string, child: T): T;
export type WorkflowChildProcessEvidence = {
    state: "observed";
    children: ProcessTerminal[];
} | {
    state: "pending" | "unknown";
    reason: string;
};
/** `unresolvedProof` is set only when a terminal child's status matches its roster run id and runner identity, and just its process proof is missing. */
export type WorkflowChildEvidence = {
    state: "resolved";
    proof: ProcessTerminal;
} | {
    state: "pending" | "unknown";
    reason: string;
    unresolvedProof?: {
        status: AsyncStatus;
        proofState: string;
    };
};
/**
 * Process evidence for a workflow's async children. Status proofs and capacity
 * release both use this so they cannot disagree about the same workflow.
 */
export declare function readWorkflowChildProcessEvidence(workflowAsyncDir: string, steps: AsyncStatus["steps"]): WorkflowChildProcessEvidence;
/** Evidence for one roster entry; undefined for synchronous children, which run inside the workflow host and have no process of their own, and for async children whose launch failed before a runner existed. */
export declare function readWorkflowChildEvidence(workflowAsyncDir: string, step: NonNullable<AsyncStatus["steps"]>[number]): WorkflowChildEvidence | undefined;
/** A persistent workflow host is terminal only after dispatch closes and every async child has process evidence. */
export declare function readWorkflowTerminalProof(asyncDir: string, steps: AsyncStatus["steps"], summary: WorkflowChildSummary, hostCommandCount: number, closedAt: number): WorkflowTerminalProof;
