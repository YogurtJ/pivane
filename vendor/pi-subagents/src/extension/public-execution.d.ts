export interface PublicSubagentExecutionParams {
    action?: unknown;
    capabilities?: unknown;
    mode?: unknown;
    repo?: unknown;
    planId?: unknown;
    agent?: unknown;
    task?: unknown;
    handoffPath?: unknown;
    laneId?: unknown;
    merge?: unknown;
    supersession?: unknown;
    step?: unknown;
    tasks?: unknown;
    chain?: unknown;
    parallel?: unknown;
    concurrency?: unknown;
    chainDir?: unknown;
    chainName?: unknown;
    config?: unknown;
    workflow?: unknown;
    args?: unknown;
    workflowScript?: unknown;
    workflowScriptPath?: unknown;
    sessionOnly?: unknown;
    globalConcurrencyLimit?: unknown;
    maxSubagentSpawnsPerRun?: unknown;
    preflight?: unknown;
    isolation?: unknown;
    worktree?: unknown;
    baseRef?: unknown;
    lane?: unknown;
    async?: unknown;
    output?: unknown;
    resume?: unknown;
    clarify?: unknown;
    workflowParentRunId?: unknown;
    workflowKey?: unknown;
    workflowChildAsyncId?: unknown;
    workflowAwaitAsync?: unknown;
    workflowAwaitDetached?: unknown;
    workflowParentDeadlineAt?: unknown;
    suppressRoutineResultIntercom?: unknown;
    runFanoutBudget?: unknown;
    runFanoutAdmitted?: unknown;
}
export type PublicSubagentExecutionMode = "workflow" | "management";
export type PublicSubagentExecutionNormalization<T> = {
    ok: true;
    params: T;
} | {
    ok: false;
    error: string;
    mode: PublicSubagentExecutionMode;
};
/** A workflow value containing "/" or "\" is a script path; named workflow resource names contain neither. */
export declare function isWorkflowScriptPath(workflow: string): boolean;
/**
 * Model tool calls supply script text only through workflow: true (the reply block) or a script path.
 * workflowScript remains the internal carrier for slash, prompt-workflow, scheduled, RPC, and named-resource launches.
 */
export declare function removedModelWorkflowFieldError(params: object): string | undefined;
export declare function validateWorkflowCapacityOverrides(params: PublicSubagentExecutionParams): string | undefined;
/**
 * Enforce the public execution cutover before requests reach the executor.
 * Internal runs.run children and structured owned delegation bypass this boundary.
 */
export declare function normalizePublicSubagentExecution<T extends PublicSubagentExecutionParams>(params: T, options?: {
    structuredWorkflows?: boolean;
}): PublicSubagentExecutionNormalization<T>;
//# sourceMappingURL=public-execution.d.ts.map