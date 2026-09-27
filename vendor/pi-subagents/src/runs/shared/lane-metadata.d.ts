import type { AsyncStatus, ManagedWorktreeProvider, WorktreeNaming, WorkflowLaneMetadata } from "../../shared/types.ts";
export declare const WORKFLOW_LANE_KEY_MAX_BYTES = 128;
export declare const WORKFLOW_LANE_SOURCE_REF_MAX_BYTES = 128;
export declare const WORKFLOW_LANE_CLAIM_MAX_BYTES = 160;
export declare const WORKFLOW_LANE_CLAIMS_MAX = 20;
export declare const WORKFLOW_LANE_OUTPUT_PATH_MAX_BYTES = 256;
export declare const WORKFLOW_LANE_OUTPUT_PATHS_MAX = 10;
export declare const WORKTREE_STATUS_PATH_MAX_BYTES = 4096;
export declare const WORKTREE_STATUS_BRANCH_MAX_BYTES = 256;
export declare const WORKTREE_STATUS_NAMING_LABEL_MAX_BYTES = 256;
/** Normalize and validate launch-declared lane metadata. */
export declare function normalizeWorkflowLaneMetadata(value: unknown, label?: string): WorkflowLaneMetadata | undefined;
export declare function assertWorkflowLaneKey(lane: WorkflowLaneMetadata | undefined, workflowKey: string | undefined, label?: string): void;
export interface WorktreeStatusReference {
    worktreePath: string;
    branch: string;
    provider?: ManagedWorktreeProvider;
    naming?: WorktreeNaming;
}
/** Validate the display-only worktree fields copied into status.json. */
export declare function normalizeWorktreeStatusReference(value: unknown, label?: string): WorktreeStatusReference | undefined;
/** Validate only the additive lane/worktree fields of a persisted async status. */
export declare function validateAsyncStatusLaneMetadata(status: Pick<AsyncStatus, "runId" | "workflowKey" | "lane" | "steps">, label?: string): void;
//# sourceMappingURL=lane-metadata.d.ts.map