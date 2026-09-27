import { type ProcessTerminal } from "../../shared/types.ts";
export { processTerminalCandidatePath, readProcessTerminalCandidate, writeProcessTerminalCandidate, markProcessTerminalCandidateLeaseRelease } from "./process-terminal-candidate.ts";
export type { ProcessTerminalCandidate } from "./process-terminal-candidate.ts";
export interface RunnerCloseObservation {
    processInstanceId: string;
    closeObservedAt: number;
    exitCode: number | null;
    signal: string | null;
}
export declare function processTerminalPath(asyncDir: string): string;
/** Establish ownership before authorizing a runner to start any child session. */
export declare function initializeProcessTerminal(asyncDir: string, runId: string, runnerProcessInstanceId: string): void;
export declare function sanitizeProcessTerminal(value: unknown, fallback: {
    runId?: string;
    runnerProcessInstanceId?: string;
}, label?: string): ProcessTerminal | undefined;
export declare function readProcessTerminal(asyncDir: string, fallback?: {
    runId?: string;
    runnerProcessInstanceId?: string;
}): ProcessTerminal | undefined;
export declare function finalizeProcessTerminal(asyncDir: string, runId: string, runnerClose: RunnerCloseObservation): ProcessTerminal;
//# sourceMappingURL=process-terminal.d.ts.map