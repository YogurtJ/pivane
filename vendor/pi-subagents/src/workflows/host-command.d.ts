export interface WorkflowHostCommandParams {
    kind: "command";
    command: string;
    timeoutMs: number;
    output?: string;
    role?: "ci" | "gate";
    provider?: string;
}
export interface WorkflowHostCommandResult {
    key: string;
    kind: "command";
    ok: boolean;
    state: "passed" | "failed" | "timed-out" | "stopped";
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputPath: string;
    durationMs: number;
    error?: string;
}
export declare function normalizeWorkflowHostCommandParams(value: unknown, label?: string): WorkflowHostCommandParams;
export declare function resolveWorkflowHostOutputClaimPath(outputPath: string): string;
export declare function executeWorkflowHostCommand(input: {
    key: string;
    params: WorkflowHostCommandParams;
    cwd: string;
    defaultOutputPath: string;
    claimedOutputPath?: string;
    signal: AbortSignal;
}): Promise<WorkflowHostCommandResult>;
//# sourceMappingURL=host-command.d.ts.map