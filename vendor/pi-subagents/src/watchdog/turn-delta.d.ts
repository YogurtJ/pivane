export interface WatchdogTurnDeltaInput {
    userPrompt?: string;
    includeUserPrompt?: boolean;
    messages?: unknown[];
    events?: unknown[];
    finalAssistantStop?: boolean;
    /** A validated structured output is the authoritative terminal response. */
    structuredTerminal?: boolean;
}
export declare function formatWatchdogReviewMessage(message: unknown, options?: {
    structuredTerminal?: boolean;
}): string | undefined;
export declare function formatWatchdogTurnDelta(input: WatchdogTurnDeltaInput): string;
/** Only completed, exactly paired native orchestration calls are activity evidence. */
export declare function formatWatchdogOrchestrationActivity(event: unknown): string;
//# sourceMappingURL=turn-delta.d.ts.map