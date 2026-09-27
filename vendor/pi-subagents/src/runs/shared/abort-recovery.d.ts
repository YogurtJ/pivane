import type { Message } from "@earendil-works/pi-ai";
export declare const ABORT_RECOVERY_PROMPT = "The prior run ended from a provider/transport abort after useful progress. Continue from the current files and transcript. Do not restart. Fix any validation failure or write the required report. Finish with final output.";
export type AbortRecoveryPlan = {
    action: "resume";
    prompt: typeof ABORT_RECOVERY_PROMPT;
} | {
    action: "settle";
    reason: string;
    diagnostic?: string;
};
export declare function planAbortRecovery(input: {
    messages: readonly Message[];
    error?: string;
    processSignal?: string | null;
    sessionAvailable: boolean;
    alreadyResumed: boolean;
    stopped?: boolean;
    interrupted?: boolean;
    timedOut?: boolean;
    toolBudgetExhausted?: boolean;
    usageBudgetExhausted?: boolean;
    structuredOutputFailed?: boolean;
    acceptanceFailed?: boolean;
    currentTool?: string;
    afterCompactionSettlement?: boolean;
}): AbortRecoveryPlan;
//# sourceMappingURL=abort-recovery.d.ts.map