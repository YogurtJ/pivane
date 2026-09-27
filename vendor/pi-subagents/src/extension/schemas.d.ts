/**
 * TypeBox schemas for subagent tool parameters
 */
import { Type } from "typebox";
export declare const ParallelTaskSchema: Type.TObject<{
    agent: Type.TString;
    task: Type.TOptional<Type.TString>;
    phase: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    as: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    machine: Type.TOptional<Type.TString>;
    count: Type.TOptional<Type.TInteger>;
    output: Type.TOptional<Type.TUnsafe<unknown>>;
    outputMode: Type.TOptional<Type.TString>;
    reads: Type.TOptional<Type.TUnsafe<unknown>>;
    progress: Type.TOptional<Type.TBoolean>;
    skill: Type.TOptional<Type.TUnsafe<unknown>>;
    model: Type.TOptional<Type.TString>;
    fast: Type.TOptional<Type.TBoolean>;
    toolBudget: Type.TOptional<Type.TObject<{
        soft: Type.TOptional<Type.TInteger>;
        hard: Type.TInteger;
        block: Type.TOptional<Type.TUnsafe<unknown>>;
    }>>;
    acceptance: Type.TOptional<Type.TUnsafe<unknown>>;
    agentContract: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
    }>>;
    gateOn: Type.TOptional<Type.TString>;
}>;
export declare const DynamicExpandSchema: Type.TObject<{
    from: Type.TObject<{
        output: Type.TString;
        path: Type.TString;
    }>;
    item: Type.TOptional<Type.TString>;
    key: Type.TOptional<Type.TString>;
    maxItems: Type.TOptional<Type.TInteger>;
    onEmpty: Type.TOptional<Type.TString>;
}>;
export declare const DynamicParallelTemplateSchema: Type.TObject<{
    agent: Type.TString;
    task: Type.TOptional<Type.TString>;
    phase: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    machine: Type.TOptional<Type.TString>;
    output: Type.TOptional<Type.TUnsafe<unknown>>;
    outputMode: Type.TOptional<Type.TString>;
    reads: Type.TOptional<Type.TUnsafe<unknown>>;
    progress: Type.TOptional<Type.TBoolean>;
    skill: Type.TOptional<Type.TUnsafe<unknown>>;
    model: Type.TOptional<Type.TString>;
    fast: Type.TOptional<Type.TBoolean>;
    toolBudget: Type.TOptional<Type.TObject<{
        soft: Type.TOptional<Type.TInteger>;
        hard: Type.TInteger;
        block: Type.TOptional<Type.TUnsafe<unknown>>;
    }>>;
    acceptance: Type.TOptional<Type.TUnsafe<unknown>>;
    agentContract: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
    }>>;
    gateOn: Type.TOptional<Type.TString>;
}>;
export declare const DynamicCollectSchema: Type.TObject<{
    as: Type.TString;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
}>;
export declare const ChainItem: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    task: Type.TOptional<Type.TString>;
    phase: Type.TOptional<Type.TString>;
    label: Type.TOptional<Type.TString>;
    as: Type.TOptional<Type.TString>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    cwd: Type.TOptional<Type.TString>;
    machine: Type.TOptional<Type.TString>;
    output: Type.TOptional<Type.TUnsafe<unknown>>;
    outputMode: Type.TOptional<Type.TString>;
    reads: Type.TOptional<Type.TUnsafe<unknown>>;
    progress: Type.TOptional<Type.TBoolean>;
    skill: Type.TOptional<Type.TUnsafe<unknown>>;
    model: Type.TOptional<Type.TString>;
    fast: Type.TOptional<Type.TBoolean>;
    toolBudget: Type.TOptional<Type.TObject<{
        soft: Type.TOptional<Type.TInteger>;
        hard: Type.TInteger;
        block: Type.TOptional<Type.TUnsafe<unknown>>;
    }>>;
    acceptance: Type.TOptional<Type.TUnsafe<unknown>>;
    agentContract: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
    }>>;
    gateOn: Type.TOptional<Type.TString>;
    parallel: Type.TOptional<Type.TUnsafe<unknown>>;
    expand: Type.TOptional<Type.TObject<{
        from: Type.TObject<{
            output: Type.TString;
            path: Type.TString;
        }>;
        item: Type.TOptional<Type.TString>;
        key: Type.TOptional<Type.TString>;
        maxItems: Type.TOptional<Type.TInteger>;
        onEmpty: Type.TOptional<Type.TString>;
    }>>;
    collect: Type.TOptional<Type.TObject<{
        as: Type.TString;
        outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    }>>;
    concurrency: Type.TOptional<Type.TNumber>;
    failFast: Type.TOptional<Type.TBoolean>;
    worktree: Type.TOptional<Type.TBoolean>;
}>;
export declare const SubagentParams: Type.TObject<{
    agent: Type.TOptional<Type.TString>;
    task: Type.TOptional<Type.TString>;
    extensionBindings: Type.TOptional<Type.TUnsafe<unknown>>;
    action: Type.TOptional<Type.TString>;
    capabilities: Type.TOptional<Type.TBoolean>;
    name: Type.TOptional<Type.TString>;
    id: Type.TOptional<Type.TString>;
    runId: Type.TOptional<Type.TString>;
    dir: Type.TOptional<Type.TString>;
    handoffPath: Type.TOptional<Type.TString>;
    repo: Type.TOptional<Type.TString>;
    planId: Type.TOptional<Type.TString>;
    laneId: Type.TOptional<Type.TString>;
    merge: Type.TOptional<Type.TUnsafe<unknown>>;
    supersession: Type.TOptional<Type.TUnsafe<unknown>>;
    index: Type.TOptional<Type.TInteger>;
    childId: Type.TOptional<Type.TString>;
    view: Type.TOptional<Type.TString>;
    lines: Type.TOptional<Type.TInteger>;
    topic: Type.TOptional<Type.TString>;
    message: Type.TOptional<Type.TString>;
    mode: Type.TOptional<Type.TString>;
    steeringRecovery: Type.TOptional<Type.TBoolean>;
    additional: Type.TOptional<Type.TInteger>;
    scope: Type.TOptional<Type.TString>;
    target: Type.TOptional<Type.TString>;
    focus: Type.TOptional<Type.TBoolean>;
    thinking: Type.TOptional<Type.TUnsafe<unknown>>;
    at: Type.TOptional<Type.TString>;
    every: Type.TOptional<Type.TString>;
    sessionOnly: Type.TOptional<Type.TBoolean>;
    quiet: Type.TOptional<Type.TBoolean>;
    on: Type.TOptional<Type.TUnsafe<unknown>>;
    timezone: Type.TOptional<Type.TString>;
    overlap: Type.TOptional<Type.TString>;
    catchUp: Type.TOptional<Type.TString>;
    missionId: Type.TOptional<Type.TString>;
    mission: Type.TOptional<Type.TUnsafe<unknown>>;
    missionUpdate: Type.TOptional<Type.TUnsafe<unknown>>;
    missionStatus: Type.TOptional<Type.TString>;
    missionScope: Type.TOptional<Type.TString>;
    runMode: Type.TOptional<Type.TString>;
    runStatus: Type.TOptional<Type.TString>;
    summary: Type.TOptional<Type.TString>;
    config: Type.TOptional<Type.TUnsafe<unknown>>;
    workflow: Type.TOptional<Type.TString>;
    args: Type.TOptional<Type.TUnsafe<unknown>>;
    workflowScript: Type.TOptional<Type.TString>;
    workflowScriptPath: Type.TOptional<Type.TString>;
    globalConcurrencyLimit: Type.TOptional<Type.TInteger>;
    maxSubagentSpawnsPerRun: Type.TOptional<Type.TInteger>;
    preflight: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
        coverage: Type.TOptional<Type.TString>;
        lanes: Type.TArray<Type.TObject<{
            key: Type.TString;
            mode: Type.TOptional<Type.TString>;
            decision: Type.TOptional<Type.TString>;
            claims: Type.TOptional<Type.TArray<Type.TString>>;
            expectedOutput: Type.TOptional<Type.TString>;
            independence: Type.TOptional<Type.TString>;
        }>>;
    }>>;
    chatProgress: Type.TOptional<Type.TString>;
    isolation: Type.TOptional<Type.TString>;
    worktree: Type.TOptional<Type.TBoolean>;
    baseRef: Type.TOptional<Type.TString>;
    lane: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
        key: Type.TString;
        mode: Type.TOptional<Type.TString>;
        sourceRef: Type.TOptional<Type.TString>;
        claims: Type.TOptional<Type.TArray<Type.TString>>;
        outputPaths: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    context: Type.TOptional<Type.TString>;
    async: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    maxRuntimeMs: Type.TOptional<Type.TInteger>;
    checkpointBeforeDeadlineMs: Type.TOptional<Type.TInteger>;
    toolTimeoutMs: Type.TOptional<Type.TInteger>;
    toolBudget: Type.TOptional<Type.TObject<{
        soft: Type.TOptional<Type.TInteger>;
        hard: Type.TInteger;
        block: Type.TOptional<Type.TUnsafe<unknown>>;
    }>>;
    usageBudget: Type.TOptional<Type.TObject<{
        tokens: Type.TOptional<Type.TObject<{
            soft: Type.TOptional<Type.TNumber>;
            hard: Type.TNumber;
        }>>;
        costUsd: Type.TOptional<Type.TObject<{
            soft: Type.TOptional<Type.TNumber>;
            hard: Type.TNumber;
        }>>;
    }>>;
    agentScope: Type.TOptional<Type.TString>;
    cwd: Type.TOptional<Type.TString>;
    machine: Type.TOptional<Type.TString>;
    artifacts: Type.TOptional<Type.TBoolean>;
    includeProgress: Type.TOptional<Type.TBoolean>;
    share: Type.TOptional<Type.TBoolean>;
    sessionDir: Type.TOptional<Type.TString>;
    control: Type.TOptional<Type.TObject<{
        enabled: Type.TOptional<Type.TBoolean>;
        needsAttentionAfterMs: Type.TOptional<Type.TInteger>;
        activeNoticeAfterMs: Type.TOptional<Type.TInteger>;
        activeNoticeAfterTurns: Type.TOptional<Type.TInteger>;
        activeNoticeAfterTokens: Type.TOptional<Type.TInteger>;
        failedToolAttemptsBeforeAttention: Type.TOptional<Type.TInteger>;
        notifyOn: Type.TOptional<Type.TArray<Type.TString>>;
        notifyChannels: Type.TOptional<Type.TArray<Type.TString>>;
    }>>;
    output: Type.TOptional<Type.TUnsafe<unknown>>;
    outputMode: Type.TOptional<Type.TString>;
    skill: Type.TOptional<Type.TUnsafe<unknown>>;
    model: Type.TOptional<Type.TString>;
    fast: Type.TOptional<Type.TBoolean>;
    outputSchema: Type.TOptional<Type.TUnsafe<unknown>>;
    agentContract: Type.TOptional<Type.TObject<{
        version: Type.TInteger;
    }>>;
    acceptance: Type.TOptional<Type.TUnsafe<unknown>>;
    gate: Type.TOptional<Type.TUnsafe<unknown>>;
}>;
export declare function createSubagentParamsSchema(): typeof SubagentParams;
export declare const SubagentWaitParams: Type.TObject<{
    id: Type.TOptional<Type.TString>;
    nonBlocking: Type.TOptional<Type.TBoolean>;
    all: Type.TOptional<Type.TBoolean>;
    timeoutMs: Type.TOptional<Type.TInteger>;
    stopOnAttention: Type.TOptional<Type.TBoolean>;
}>;
//# sourceMappingURL=schemas.d.ts.map