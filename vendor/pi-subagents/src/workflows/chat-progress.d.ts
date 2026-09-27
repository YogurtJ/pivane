import type { Details, WorkflowPreflightLane, WorkflowPreflight } from "../shared/types.ts";
export declare const WORKFLOW_CHAT_PROGRESS_MODES: readonly ["auto", "off", "live-card"];
export type WorkflowChatProgressMode = typeof WORKFLOW_CHAT_PROGRESS_MODES[number];
export type ResolvedWorkflowChatProgressMode = Exclude<WorkflowChatProgressMode, "auto">;
export interface GitRepositoryIdentity {
    root: string;
    commonDir: string;
}
export interface WorkflowChatProgressProjection {
    mode: ResolvedWorkflowChatProgressMode;
    repoRelation: "same" | "other";
    repoLabel?: string;
}
interface ResolveWorkflowChatProgressInput {
    requested: unknown;
    parentCwd: string;
    workflowCwd: string;
    background: boolean;
}
export declare function resolveGitRepositoryIdentity(cwd: string): GitRepositoryIdentity | undefined;
export declare function isSameGitRepository(leftCwd: string, rightCwd: string): boolean;
export declare function resolveWorkflowChatProgress(input: ResolveWorkflowChatProgressInput): {
    projection?: WorkflowChatProgressProjection;
    error?: string;
};
export interface WorkflowChatProgressRow {
    key: string;
    state: "planned" | "running" | "complete" | "failed" | "detached" | "stopped";
    label?: string;
    phase?: string;
    runId?: string;
    durationMs?: number;
    error?: string;
    preflight?: WorkflowPreflightLane;
}
export declare function buildWorkflowChatProgressRows(trace: NonNullable<Details["workflow"]>["trace"], preflight?: WorkflowPreflight): WorkflowChatProgressRow[];
export {};
//# sourceMappingURL=chat-progress.d.ts.map