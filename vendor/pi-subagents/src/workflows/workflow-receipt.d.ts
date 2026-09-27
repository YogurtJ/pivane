import type { WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState, WorkflowResourceProvenance, WorkflowTerminalOutcome } from "../shared/types.ts";
import type { WorkflowReceiptResumeReference, WorkflowScriptChildResult } from "./scripted-workflow.ts";
export type { WorkflowReceipt, WorkflowReceiptEntry, WorkflowReceiptState } from "../shared/types.ts";
export declare const WORKFLOW_RECEIPT_VERSION = 1;
export declare const WORKFLOW_RECEIPT_FILE = "workflow-receipt.json";
export declare function workflowReceiptPath(asyncDirRoot: string, workflowRunId: string): string;
export declare function buildWorkflowReceipt(input: {
    workflowRunId: string;
    state: WorkflowReceiptState;
    children: WorkflowScriptChildResult[];
    argsDigest?: string;
    hostSteps?: WorkflowReceipt["hostSteps"];
    workflowChildren?: WorkflowReceipt["workflowChildren"];
    resource?: WorkflowResourceProvenance;
    terminalOutcome?: WorkflowTerminalOutcome;
    createdAt?: number;
}): WorkflowReceipt;
export declare function writeWorkflowReceipt(asyncDir: string, receipt: WorkflowReceipt): string;
export declare function readWorkflowReceipt(asyncDirRoot: string, workflowRunId: string): WorkflowReceipt;
export declare function resolveWorkflowReceiptResumeEntry(input: {
    reference: WorkflowReceiptResumeReference;
    asyncDirRoot: string;
    assertResumable?: (runId: string) => void;
}): WorkflowReceiptEntry & {
    latestRunId: string;
    resumability: {
        state: "resumable";
    };
};
export declare function resolveWorkflowReceiptResume(input: {
    reference: WorkflowReceiptResumeReference;
    asyncDirRoot: string;
    assertResumable?: (runId: string) => void;
}): string;
//# sourceMappingURL=workflow-receipt.d.ts.map