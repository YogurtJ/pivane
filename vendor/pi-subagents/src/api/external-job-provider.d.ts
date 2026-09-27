export declare const EXTERNAL_JOB_PROVIDER_PROTOCOL_VERSION = 1;
export declare const EXTERNAL_JOB_PROVIDER_REGISTRY_KEY = "pi-subagents.external-job-providers.v1";
export type ExternalJobState = "queued" | "running" | "completed" | "failed" | "stopped" | "blocked";
export type ExternalJobOperation = "start" | "follow-up" | "status" | "result" | "reattach";
export type ExternalJobOptions = Record<string, unknown>;
export interface ExternalJobStartInput {
    prompt: string;
    promptDigest: string;
    cwd: string;
    runId: string;
    stepIndex: number;
    agent: string;
    options: ExternalJobOptions;
    sessionId?: string;
}
export interface ExternalJobFollowUpInput extends ExternalJobStartInput {
    sourceRunId: string;
    sourceStepIndex: number;
    parentProviderJobId: string;
    requestId: string;
    requestDigest: string;
}
export interface ExternalJobHandle {
    providerJobId: string;
    state: ExternalJobState;
    handleUrl?: string;
    conversationUrl?: string;
    failureCode?: string;
    failureMessage?: string;
    blockingJobId?: string;
}
export interface ExternalJobResult extends ExternalJobHandle {
    output?: string;
    artifactPath?: string;
}
export interface ExternalJobProvider {
    name: string;
    start(input: ExternalJobStartInput): Promise<ExternalJobHandle> | ExternalJobHandle;
    followUp?(input: ExternalJobFollowUpInput): Promise<ExternalJobHandle> | ExternalJobHandle;
    status(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
    result(providerJobId: string): Promise<ExternalJobResult> | ExternalJobResult;
    reattach(providerJobId: string): Promise<ExternalJobHandle> | ExternalJobHandle;
}
export declare class ExternalJobProviderError extends Error {
    readonly code: string;
    readonly blockingJobId?: string;
    constructor(message: string, options: {
        code: string;
        blockingJobId?: string;
        cause?: unknown;
    });
}
export declare function validateExternalJobHandle(provider: string, value: unknown, field?: string): ExternalJobHandle;
export declare function validateExternalJobResult(provider: string, value: unknown, field?: string): ExternalJobResult;
export declare function registerExternalJobProvider(provider: ExternalJobProvider): () => void;
export declare function listExternalJobProviders(): readonly ExternalJobProvider[];
export declare function getExternalJobProvider(name: string): ExternalJobProvider | undefined;
//# sourceMappingURL=external-job-provider.d.ts.map