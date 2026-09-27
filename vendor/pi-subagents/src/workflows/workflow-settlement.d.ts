import type { AsyncStatus, WorkflowRecoveryAction, WorkflowTerminalOutcome, WorkflowTerminalResolution, Usage } from "../shared/types.ts";
import type { WorkflowReceipt } from "./workflow-receipt.ts";
export declare const UNSUPPORTED_DETACHED_WORKFLOW_CONTINUATION = "unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted. Resume the workflow explicitly instead of treating the completed child as top-level workflow completion.";
export declare const INTERRUPTED_DETACHED_CHILD = "Interrupted. Waiting for explicit next action.";
export declare const EVIDENCE_PERSISTENCE_FAILED = "evidence-persistence-failed";
export type WorkflowStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
    outputPathMapping?: {
        requestedPath: string;
        savedPath: string;
    };
    interrupted?: boolean;
};
export interface WorkflowPublicChild {
    workflowKey?: string;
    agent?: string;
    /** Human-readable display name for the child session, when derived at launch. */
    sessionName?: string;
    runId?: string;
    usage?: Usage;
    sessionFile?: string;
    output: string;
    outputState: "present" | "absent";
    structuredOutput?: unknown;
    /** Omitted for running launch receipts. */
    success?: boolean;
    state?: "running";
    asyncDir?: string;
    terminalOutcome?: WorkflowTerminalOutcome;
    outputReference?: string;
    outputPathMapping?: {
        requestedPath: string;
        savedPath: string;
    };
    stopped?: boolean;
    interrupted?: boolean;
    detached?: boolean;
    error?: string;
    artifactPaths?: {
        outputPath: string;
    };
}
export interface WorkflowSettlementPlan {
    status: AsyncStatus;
    publicResult: Record<string, unknown>;
    receipt?: WorkflowReceipt;
    recovery: WorkflowRecoveryAction[];
    completionEvent?: Record<string, unknown>;
}
export declare function findWorkflowSettlementStep(status: AsyncStatus, childRunId: string, workflowKey?: string, sessionFile?: string): WorkflowStatusStep | undefined;
export declare function promoteSettledPausedWorkflow(status: AsyncStatus, now?: number): AsyncStatus | undefined;
export declare function applyDetachedChildSettlement(status: AsyncStatus, input: {
    childRunId: string;
    result: {
        exitCode: number | null;
        error?: string;
        interrupted?: boolean;
        sessionFile?: string;
        sessionName?: string;
        stopped?: boolean;
    };
    workflowKey?: string;
    now?: number;
}): AsyncStatus | undefined;
export declare function classifyWorkflowSettlement(status: AsyncStatus, interrupted?: boolean): WorkflowTerminalResolution | undefined;
export declare function workflowRecoveryActions(receipt: WorkflowReceipt | undefined): WorkflowRecoveryAction[];
export declare function workflowTerminalOutcomeForResult(result: {
    timedOut?: boolean;
    turnBudgetExceeded?: boolean;
    toolBudgetBlocked?: boolean;
}): WorkflowTerminalOutcome | undefined;
export declare function workflowOutputPathMappingSummary(children: readonly unknown[]): string;
export declare function planWorkflowSettlement(input: {
    status: AsyncStatus;
    summary: string;
    children: WorkflowPublicChild[];
    baseResult: Record<string, unknown>;
    receipt?: WorkflowReceipt;
    receiptPath?: string;
    receiptPersistenceError?: string;
    resolution?: WorkflowTerminalResolution;
    terminalOutcome?: WorkflowTerminalOutcome;
    now?: number;
    eventMetadata?: Record<string, unknown>;
}): WorkflowSettlementPlan;
//# sourceMappingURL=workflow-settlement.d.ts.map