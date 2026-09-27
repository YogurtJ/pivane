export type RunOutcome = "completed" | "failed" | "timed_out" | "stopped" | "interrupted";
export interface RunEntry {
    agent: string;
    task: string;
    taskHash?: string;
    ts: number;
    status: "ok" | "error";
    outcome?: RunOutcome;
    duration: number;
    exit?: number;
}
export declare function recordRun(agent: string, task: string, exitCode: number, durationMs: number, terminal?: {
    interrupted?: boolean;
    processSignal?: string | null;
    stopped?: boolean;
    timedOut?: boolean;
    turnBudgetExceeded?: boolean;
}): void;
export declare function loadRunsForAgent(agent: string): RunEntry[];
//# sourceMappingURL=run-history.d.ts.map