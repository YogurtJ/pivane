import type { ActivityState, AsyncJobStep } from "./types.ts";
type StepStatusLike = Pick<AsyncJobStep, "status">;
export declare function formatActivityLabel(lastActivityAt: number | undefined, activityState?: ActivityState, now?: number): string | undefined;
export declare function aggregateStepStatus(steps: StepStatusLike[]): AsyncJobStep["status"];
export declare function formatAgentRunningLabel(count: number): string;
export declare function formatParallelOutcome(steps: StepStatusLike[], total: number, options?: {
    showRunning?: boolean;
}): string;
export {};
//# sourceMappingURL=status-format.d.ts.map