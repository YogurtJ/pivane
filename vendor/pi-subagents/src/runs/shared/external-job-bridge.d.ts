import { ExternalJobProviderError, type ExternalJobHandle, type ExternalJobOperation, type ExternalJobResult, type ExternalJobFollowUpInput, type ExternalJobStartInput } from "../../api/external-job-provider.ts";
export declare const EXTERNAL_JOB_BRIDGE_REQUEST_DIR = "external-job-requests";
interface ExternalJobBridgeRequest {
    id: string;
    operation: ExternalJobOperation;
    provider: string;
    providerJobId?: string;
    start?: ExternalJobStartInput;
    followUp?: ExternalJobFollowUpInput;
    createdAt: number;
    claimedAt?: number;
}
export type ExternalJobBridgeCancel = () => ExternalJobProviderError | undefined;
export declare function externalJobBridgeEligibility(steps: unknown): "required" | "not-required" | "unknown";
/** Services the bridges of external-job runs that a child session launched; only the root has an async job tracker. */
export declare function createChildExternalJobBridgeSweeper(): {
    track(runId: string, asyncDir: string): void;
    sweep: () => number;
    dispose(): void;
};
export declare function serviceExternalJobBridgeRequests(asyncDir: string): void;
export declare function serviceExternalJobBridgeRequestFile(asyncDir: string, file: string): void;
export declare function requestExternalJobOperation<T extends ExternalJobHandle | ExternalJobResult>(asyncDir: string, request: Omit<ExternalJobBridgeRequest, "id" | "createdAt">, timeoutMs?: number, cancel?: ExternalJobBridgeCancel): Promise<T>;
export {};
//# sourceMappingURL=external-job-bridge.d.ts.map