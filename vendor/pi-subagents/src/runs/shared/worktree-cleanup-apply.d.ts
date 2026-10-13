import { type BuildWorktreeCleanupPlanInput, type WorktreeCleanupPlan } from "./worktree-cleanup-plan.ts";
export type CleanupReceipt = {
    version: 1;
    planId: string;
    repoRoot: string;
    contentHash: string;
    state: "applying" | "complete" | "partial";
    startedAt: number;
    completedAt?: number;
    error?: string;
    entries: Array<{
        path: string;
        branch: string;
        state: "removing" | "removed" | "kept" | "failed";
        reason: string;
    }>;
};
export declare function loadReviewedCleanupPlan(repo: string, planId: string, now?: number): WorktreeCleanupPlan;
export declare function applyReviewedCleanupPlan(input: {
    repo: string;
    planId: string;
    authorized: boolean;
    signal?: AbortSignal;
    foregroundRunOwnership?: BuildWorktreeCleanupPlanInput["foregroundRunOwnership"];
    /** Internal retention seam: shrink the reviewed batch while holding the repository lock. */
    select?: (plan: WorktreeCleanupPlan) => Set<string>;
}): Promise<{
    receipt: CleanupReceipt;
    receiptPath: string;
    reused: boolean;
}>;
export declare function formatCleanupReceipt(result: {
    receipt: CleanupReceipt;
    receiptPath: string;
    reused: boolean;
}): string;
//# sourceMappingURL=worktree-cleanup-apply.d.ts.map