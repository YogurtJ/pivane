import type { ProcessInstanceExit } from "../../shared/types.ts";
export interface ProcessTerminalCandidate {
    version: 1;
    runId: string;
    runnerProcessInstanceId: string;
    writers: Record<string, ProcessInstanceExit[]>;
    expectedWriters?: Record<string, number>;
    sessionFile?: string;
    revivalLeaseToken?: string;
    revivalLeaseReleaseAcknowledged?: boolean;
}
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function validProcessInstance(value: unknown, kind?: "runner" | "pi-writer"): value is ProcessInstanceExit;
export declare function processTerminalCandidatePath(asyncDir: string): string;
export declare function readProcessTerminalCandidate(asyncDir: string): ProcessTerminalCandidate | undefined;
export declare function writeProcessTerminalCandidate(asyncDir: string, candidate: ProcessTerminalCandidate): void;
export declare function markProcessTerminalCandidateLeaseRelease(asyncDir: string, token: string, acknowledged: boolean): void;
//# sourceMappingURL=process-terminal-candidate.d.ts.map