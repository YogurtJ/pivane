export declare function formatProcessSignalError(signal: string): string;
export declare function formatMidToolExitError(input: {
    toolName: string;
    exitCode?: number | null;
    processSignal?: string | null;
}): string;
export declare function isOrdinaryToolForMidToolExit(toolName: string): boolean;
export declare function isUnexplainedProcessSignal(input: {
    processSignal?: string | null;
    interrupted?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudgetExceeded?: boolean;
    forcedDrainAfterFinalSuccess?: boolean;
}): boolean;
//# sourceMappingURL=process-signal.d.ts.map