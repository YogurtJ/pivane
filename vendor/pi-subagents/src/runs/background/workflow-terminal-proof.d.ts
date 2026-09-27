import type { AsyncStatus, ProcessTerminal, WorkflowChildSummary, WorkflowTerminalProof } from "../../shared/types.ts";
export declare function isTerminalAsyncState(state: AsyncStatus["state"]): boolean;
export type WorkflowChildProcessEvidence = {
    state: "observed";
    children: ProcessTerminal[];
} | {
    state: "pending" | "unknown";
    reason: string;
};
/**
 * Process evidence for a workflow's async children. Status proofs and capacity
 * release both use this so they cannot disagree about the same workflow.
 * Synchronous children run inside the workflow host and have no process of their own.
 */
export declare function readWorkflowChildProcessEvidence(workflowAsyncDir: string, steps: AsyncStatus["steps"]): WorkflowChildProcessEvidence;
/** A persistent workflow host is terminal only after dispatch closes and every async child has process evidence. */
export declare function readWorkflowTerminalProof(asyncDir: string, steps: AsyncStatus["steps"], summary: WorkflowChildSummary, hostCommandCount: number, closedAt: number): WorkflowTerminalProof;
//# sourceMappingURL=workflow-terminal-proof.d.ts.map