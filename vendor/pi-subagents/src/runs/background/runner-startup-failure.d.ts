import { type ProcessTerminalCandidate } from "./process-terminal-candidate.ts";
interface RunnerStartupFailureInput {
    asyncDir: string;
    runId: string;
    runnerProcessInstanceId: string;
    message: string;
    sessionId?: string;
    completionOwnerId?: string;
    candidate?: Partial<Pick<ProcessTerminalCandidate, "sessionFile" | "revivalLeaseToken">>;
}
/** Persist a runner failure that occurred before any child writer could start. */
export declare function persistRunnerStartupFailure(input: RunnerStartupFailureInput): void;
export {};
//# sourceMappingURL=runner-startup-failure.d.ts.map