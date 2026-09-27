import type { ResolvedControlConfig } from "../../shared/types.ts";
interface LongRunningNoticeMetrics {
    startedAt: number;
    now: number;
    turns: number;
    tokens: number;
}
type LongRunningTriggerReason = "time_threshold" | "turn_threshold" | "token_threshold";
interface FailedMutatingAttempt {
    tool: string;
    path?: string;
    error: string;
    ts: number;
}
interface MutatingFailureState {
    consecutiveFailures: number;
    lastFailureAt?: number;
    recentFailures: FailedMutatingAttempt[];
    lastMutatingPath?: string;
    repeatedPathFailures: number;
}
export declare function resolveCurrentPath(toolName: string | undefined, args: Record<string, unknown> | undefined): string | undefined;
export declare function isMutatingBashCommand(command: string): boolean;
export declare function isMutatingTool(toolName: string | undefined, args: Record<string, unknown> | undefined, mutationTools?: readonly string[]): boolean;
export declare function didMutatingToolFail(text: string): boolean;
export declare function nextLongRunningTrigger(config: ResolvedControlConfig, metrics: LongRunningNoticeMetrics): LongRunningTriggerReason | undefined;
export declare function resetMutatingFailureState(state: MutatingFailureState): void;
export declare function createMutatingFailureState(): MutatingFailureState;
export declare function recordMutatingFailure(state: MutatingFailureState, input: FailedMutatingAttempt, windowMs: number): void;
export declare function shouldEscalateMutatingFailures(state: MutatingFailureState, threshold: number): boolean;
export declare function summarizeRecentMutatingFailures(state: MutatingFailureState): string | undefined;
export {};
//# sourceMappingURL=long-running-guard.d.ts.map