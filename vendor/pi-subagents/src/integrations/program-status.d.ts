import type { AsyncJobState } from "../shared/types.ts";
export interface ProgramStatusReporterOptions {
    /** `programStatus` from the user config; only `false` turns it off. */
    enabled: boolean;
    getJobs: () => Iterable<AsyncJobState>;
    /** Pending native supervisor requests that expect a reply. */
    getPendingRequests: () => Iterable<{
        id: string;
        runId: string;
    }>;
    write?: (data: string) => void;
    isTTY?: boolean;
    env?: Record<string, string | undefined>;
}
export interface ProgramStatusReporter {
    /** Only the interactive TUI session on a real terminal reports. */
    sessionStarted(input: {
        hasUI: boolean;
        mode?: string;
    }): void;
    sync(): void;
    agentStarted(): void;
    agentSettled(): void;
    /**
     * Stops reporting. Unless Pi is quitting, clears every record sent, since the runtime that replaces
     * this one cannot clear them. On quit, finished records stay for the user, as the spec intends.
     */
    dispose(shutdownReason?: string): void;
}
export declare function registerProgramStatusReporter(options: ProgramStatusReporterOptions): ProgramStatusReporter;
//# sourceMappingURL=program-status.d.ts.map