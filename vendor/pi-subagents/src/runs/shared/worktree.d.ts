import { type SetupCommandOptions, type SetupCommandResult } from "./worktree-setup-command.ts";
import { type AuthorityPolicyConfig } from "../../policy/authority.ts";
import type { ManagedWorktreeProvider, WorktreeNaming, WorktreeProvider } from "../../shared/types.ts";
export declare const DEFAULT_WORKTREE_PROVIDER: WorktreeProvider;
export declare const DEFAULT_WORKTREE_BASE_REF = "HEAD";
export declare const DEFAULT_WORKTREE_BRANCH_PREFIX = "pi-subagents/";
/** Internal marker used to defer Worktrunk-dependent instruction paths to launch time. */
export declare const WORKTREE_AGENT_CWD_PLACEHOLDER: string;
export declare const MACHINE_DIFF_OPTIONS: readonly ["--no-color", "--no-ext-diff", "--no-textconv", "--default-prefix", "--line-prefix=", "--no-relative"];
export interface WorktreeNamingInput {
    runId: string;
    index: number;
    /** Explicit step index; otherwise a trailing `-sN` in runId is used. */
    stepIndex?: number;
    /** Explicit task index; defaults to index. */
    taskIndex?: number;
    /** Label precedence is lane/workflow key, output/stable key, then this label. */
    agent?: string;
    label?: string;
    laneKey?: string;
    workflowKey?: string;
    outputName?: string;
    taskKey?: string;
    task?: string;
    branchPrefix?: string;
}
export interface WorktreeCommandResult {
    stdout: string;
    stderr: string;
    status: number | null;
    error?: Error;
}
export interface WorktreeSetup {
    cwd: string;
    worktrees: WorktreeInfo[];
    baseCommit: string;
    capturedDiffs?: WorktreeDiff[];
}
export interface WorktreeInfo {
    path: string;
    agentCwd: string;
    branch: string;
    index: number;
    nodeModulesLinked: boolean;
    syntheticPaths: string[];
    provider?: ManagedWorktreeProvider;
    naming?: WorktreeNaming;
}
export interface WorktreeDiff {
    index: number;
    agent: string;
    branch: string;
    diffStat: string;
    filesChanged: number;
    insertions: number;
    deletions: number;
    patchPath: string;
    error?: string;
}
export interface WorktreeCleanupTask {
    index: number;
    path: string;
    branch: string;
    provider?: ManagedWorktreeProvider;
    naming?: WorktreeNaming;
    worktreeRemoved: boolean;
    branchRemoved: boolean;
    preserved?: boolean;
    reason?: string;
    errors?: string[];
}
export type WorktreeCleanupIntent = {
    kind: "preserve";
    capturedDiffs?: WorktreeDiff[];
    handoffManifestPath?: string;
    cleanupBlocker?: string;
} | {
    kind: "discard";
    authorization: {
        kind: "policy";
        policy?: AuthorityPolicyConfig;
    } | {
        kind: "confirmed";
        policy?: AuthorityPolicyConfig;
    };
} | {
    kind: "setup-rollback";
};
export interface WorktreeCleanupReport {
    state: "complete" | "partial";
    tasks: WorktreeCleanupTask[];
    pruned: boolean;
    errors?: string[];
}
interface WorktreeTaskCwdConflict {
    index: number;
    agent: string;
    cwd: string;
}
interface WorktreeSetupHookConfig {
    hookPath: string;
    timeoutMs?: number;
}
export interface CreateWorktreesOptions {
    signal?: AbortSignal;
    /** Existing absolute run deadline only; setup does not start a child budget. */
    deadlineAt?: number;
    onProgress?: (snapshot: WorktreeSetupProgress) => void;
    agents?: string[];
    /** Optional stable labels used to make branch identity readable. */
    labels?: Array<string | undefined>;
    /** Original task text used for the agent-plus-slug naming fallback. */
    tasks?: Array<string | undefined>;
    /** Worktree allocator selection; auto prefers Worktrunk when available. */
    provider?: WorktreeProvider;
    /** Git ref used as the worktree base; defaults to `HEAD`. */
    baseRef?: string;
    /** Branch namespace; defaults to `pi-subagents/`. */
    branchPrefix?: string;
    setupHook?: WorktreeSetupHookConfig;
    baseDir?: string;
}
/** In-memory evidence only. Callers project this into existing handoff diagnostics. */
export interface WorktreeSetupProgress {
    setup: WorktreeSetup;
    attempts: Array<{
        index: number;
        branch: string;
        path?: string;
        validated: boolean;
        command?: WorktreeSetupProgress["command"];
        hookCommand?: WorktreeSetupProgress["command"];
    }>;
    phase: string;
    command?: {
        command: string;
        args: string[];
        pid?: number;
        processGroupId?: number;
        result?: Omit<SetupCommandResult, "stdout" | "stdoutBuffer" | "stderr">;
    };
    unknown?: string;
    cleanup?: WorktreeCleanupReport;
}
export declare class WorktreeSetupError extends Error {
    readonly snapshot: WorktreeSetupProgress;
    constructor(error: unknown, snapshot: WorktreeSetupProgress);
}
/** Later async finalization owners wrap their synchronous diff/cleanup as ONE turn. */
export declare function withWorktreeTransaction<T>(action: () => T | Promise<T>): Promise<T>;
/** Validate a captured patch against the worktree index without changing either. */
export declare function validateWorktreePatch(worktreePath: string, patchPath: string): string | undefined;
export declare function validateWorktreePatchRepresentsCurrentWorktree(worktreePath: string, baseCommit: string, patchPath: string): string | undefined;
/** Read-only admission check; allocation repeats it because source state can change. */
export declare function preflightWorktreeSource(cwd: string, options?: Pick<SetupCommandOptions, "signal" | "deadlineAt">): Promise<void>;
export declare function findWorktreeTaskCwdConflict(tasks: ReadonlyArray<{
    agent: string;
    cwd?: string;
}>, sharedCwd: string): WorktreeTaskCwdConflict | undefined;
export declare function formatWorktreeTaskCwdConflict(conflict: WorktreeTaskCwdConflict, sharedCwd: string): string;
/** Convert an arbitrary label to a single safe filesystem/branch component. */
export declare function sanitizeWorktreePathComponent(value: string, maxBytes?: number): string;
/** Normalize and validate a configured worktree base ref without resolving it. */
export declare function normalizeWorktreeBaseRef(value: unknown): string | undefined;
/** Normalize and validate the configured Git branch namespace. */
export declare function normalizeWorktreeBranchPrefix(value: string | undefined): string;
/** Build the shared branch identity used by native and Worktrunk allocation. */
export declare function buildWorktreeNaming(input: WorktreeNamingInput): WorktreeNaming;
/** Resolve a requested provider without silently switching after allocation starts. */
export declare function resolveWorktreeProvider(requested: WorktreeProvider | undefined, baseDir?: string): ManagedWorktreeProvider;
/** Whether a launch must bind its worktree-dependent paths after allocation. */
export declare function shouldDeferWorktreeCwd(requested: WorktreeProvider | undefined, baseDir?: string): boolean;
export declare function resolveExpectedWorktreeAgentCwd(cwd: string, runId: string, index: number, baseDir?: string): string;
export declare function createWorktrees(cwd: string, runId: string, count: number, options?: CreateWorktreesOptions): Promise<WorktreeSetup>;
export declare function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[];
export declare function cleanupWorktrees(setup: WorktreeSetup, intent?: WorktreeCleanupIntent): WorktreeCleanupReport;
export declare function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string;
export {};
//# sourceMappingURL=worktree.d.ts.map