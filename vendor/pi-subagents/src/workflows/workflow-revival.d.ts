import type { AsyncStatus } from "../shared/types.ts";
import type { WorkflowScriptChildResult } from "./scripted-workflow.ts";
/** The same link, kept in the revived run's directory so reviving it again keeps the key. */
export declare const REVIVAL_ORIGIN_FILE = "workflow-revival-origin.json";
export interface WorkflowKeyRevival {
    /** Revived runs after the given run, oldest first. */
    revivedRunIds: string[];
    latestRunId: string;
    /** State of the latest revived run; undefined when its status is unreadable. */
    state?: AsyncStatus["state"];
}
/**
 * Links a detached revival to the workflow key of its source run when the source failed and is
 * an async workflow child or an earlier revival of one. Throws when the source status cannot be
 * read or the key's revival chain is full; the caller reports that on the revive receipt.
 */
export declare function recordWorkflowRevival(asyncDirRoot: string, sourceRunId: string, revivedRunId: string): void;
/**
 * Follows revival links from one run of a workflow key by exact reads. Returns undefined when
 * the run was never revived; malformed or mismatched links end the chain.
 */
export declare function projectWorkflowKeyRevival(asyncDirRoot: string, workflowRunId: string, workflowKey: string, runId: string): WorkflowKeyRevival | undefined;
/** `Revived → <run> [→ <run>]: <state>`, shown next to the key's original failure. */
export declare function formatWorkflowKeyRevival(revival: WorkflowKeyRevival): string;
/**
 * Adds each failed child's revivals to its lineage, so the receipt's latest run for that key is
 * the newest revival. The child's own result and evidence stay as they were.
 */
export declare function withWorkflowRevivals<T extends WorkflowScriptChildResult>(asyncDirRoot: string, workflowRunId: string, children: T[]): Array<T & {
    revival?: WorkflowKeyRevival;
}>;
//# sourceMappingURL=workflow-revival.d.ts.map