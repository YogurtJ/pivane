export declare const WORKTREE_CLEANUP_PLAN_VERSION: 1;
export declare const WORKTREE_CLEANUP_PLAN_TTL_MS: number;
export type WorktreeCleanupPlanState = "safe" | "ineligible" | "stale" | "dirty" | "active" | "unknown";
export type WorktreeCleanupPlanDecision = "remove" | "keep" | "unknown";
export type WorktreeCleanupPlanSource = "git" | "metadata" | "both";
export type ForegroundRunOwnership = "active" | "terminal" | "unknown";
export interface WorktreeCleanupPlanPreconditions {
    path: string;
    branch: string;
    worktreeHead?: string;
    branchTip?: string;
    baseCommit?: string;
    statusDigest?: string;
    recordedBaseDir?: string;
    targetRef?: string;
}
export interface WorktreeCleanupPlanEntry {
    path: string;
    branch: string;
    decision: WorktreeCleanupPlanDecision;
    state: WorktreeCleanupPlanState;
    reasons: string[];
    source: WorktreeCleanupPlanSource;
    willDeleteBranch?: boolean;
    runId?: string;
    handoffPath?: string;
    taskIndex?: number;
    baseCommit?: string;
    patchPath?: string;
    targetRef?: string;
    preconditions: WorktreeCleanupPlanPreconditions;
}
export interface WorktreeCleanupPlan {
    version: typeof WORKTREE_CLEANUP_PLAN_VERSION;
    planId: string;
    repoRoot: string;
    createdAt: number;
    expiresAt: number;
    baseDirs: string[];
    metadataPaths: string[];
    entries: WorktreeCleanupPlanEntry[];
    pruneCandidates: string[];
    warnings?: string[];
    contentHash: string;
}
export interface BuildWorktreeCleanupPlanInput {
    repo: string;
    handoffPath?: string;
    /** Internal test and migration seam for explicitly supplied handoff records. */
    handoffPaths?: string[];
    worktreeBaseDir?: string;
    now?: number;
    planId?: string;
    /** Current-process proof for foreground owners; unknown must remain non-removable. */
    foregroundRunOwnership?: (runId: string) => ForegroundRunOwnership;
}
export interface CreatedWorktreeCleanupPlan {
    plan: WorktreeCleanupPlan;
    planPath: string;
}
interface GitWorktreeRecord {
    path: string;
    head: string;
    branch?: string;
    prunable?: string;
}
declare function realpathExisting(candidate: string, nativeRealpath?: (filePath: string) => string, fallbackRealpath?: (filePath: string) => string): string;
/** Internal test seam; this is not part of the public subagent tool API. */
export declare const __testables: {
    realpathExisting: typeof realpathExisting;
};
export declare function parseGitWorktreeList(raw: string): GitWorktreeRecord[];
export declare function buildWorktreeCleanupPlan(input: BuildWorktreeCleanupPlanInput): WorktreeCleanupPlan;
export declare function worktreeCleanupPlanPath(repoRoot: string, planId: string): string;
export declare function createWorktreeCleanupPlan(input: BuildWorktreeCleanupPlanInput): CreatedWorktreeCleanupPlan;
export declare function formatWorktreeCleanupPlan(created: CreatedWorktreeCleanupPlan): string;
export {};
//# sourceMappingURL=worktree-cleanup-plan.d.ts.map