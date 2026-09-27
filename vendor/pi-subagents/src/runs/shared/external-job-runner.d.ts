import type { ExternalJobStatus } from "../../shared/types.ts";
export interface ExternalJobRunResult {
    output: string;
    exitCode: number;
    error?: string;
    timedOut?: boolean;
    stopped?: boolean;
    externalJob: ExternalJobStatus;
}
export declare function externalJobPromptDigest(prompt: string): string;
export declare function externalJobStableJson(value: unknown): string;
export declare function externalJobFollowUpRequestDigest(input: {
    provider: string;
    parentProviderJobId: string;
    promptDigest: string;
    options: Record<string, unknown>;
}): string;
export declare function externalJobFollowUpRequestId(requestDigest: string): string;
export declare function externalJobFollowUpRunId(requestDigest: string): string;
interface ExternalJobFollowUpDescriptor {
    sourceRunId: string;
    sourceStepIndex: number;
    parentProviderJobId: string;
    requestId: string;
    requestDigest: string;
}
export declare function runExternalJob(input: {
    provider: string;
    options?: Record<string, unknown>;
    cwd: string;
    prompt: string;
    asyncDir: string;
    stepIndex: number;
    runId: string;
    agent: string;
    sessionId?: string;
    registerTimeout?: (stop: (() => void) | undefined) => void;
    registerStop?: (stop: (() => void) | undefined) => void;
    timeoutMessage?: string;
    stopMessage?: string;
    onExternalJob?: (status: ExternalJobStatus) => void;
    followUp?: ExternalJobFollowUpDescriptor;
}): Promise<ExternalJobRunResult>;
export {};
//# sourceMappingURL=external-job-runner.d.ts.map