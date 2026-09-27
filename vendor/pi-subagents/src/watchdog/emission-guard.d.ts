import type { WatchdogWarning } from "./types.ts";
export type WatchdogEmissionSuppressionReason = "content-free" | "duplicate" | "max-warnings" | "update-budget";
export type WatchdogEmissionDecision = {
    accepted: true;
    identity: string;
    underlyingIdentity: string;
    escalation: boolean;
} | {
    accepted: false;
    reason: WatchdogEmissionSuppressionReason;
    identity?: string;
    underlyingIdentity?: string;
};
export interface WatchdogEmissionGuardOptions {
    maxWarnings?: number | null;
    dedupeHistoryLimit?: number;
}
export declare function normalizeWatchdogEmissionText(value: string): string;
export declare function watchdogWarningUnderlyingIdentity(warning: Pick<WatchdogWarning, "summary" | "evidence">): string;
export declare function watchdogWarningIdentity(warning: Pick<WatchdogWarning, "severity" | "summary" | "evidence">): string;
export declare class WatchdogEmissionGuard {
    private maxWarnings;
    private dedupeHistoryLimit;
    private acceptedCount;
    private acceptedByUnderlyingIdentity;
    private historyOrder;
    private updateAcceptedUnderlyingIdentity;
    private updateAcceptedSeverity;
    constructor(options?: WatchdogEmissionGuardOptions);
    startModelUpdate(): void;
    reset(): void;
    /** `allowRepeatOf`: one already-accepted identity that may repeat (boundary re-findings before stalemate). */
    evaluate(warning: WatchdogWarning, options?: {
        allowRepeatOf?: string;
    }): WatchdogEmissionDecision;
}
//# sourceMappingURL=emission-guard.d.ts.map