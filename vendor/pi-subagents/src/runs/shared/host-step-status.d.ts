import type { AsyncStatus, HostStepNode, HostStepState, HostStepVerdict, WorkflowGraphNode, WorkflowGraphSnapshot } from "../../shared/types.ts";
export declare const HOST_STEP_MAX_ID_CHARS = 128;
export declare const HOST_STEP_MAX_LABEL_CHARS = 80;
export declare const HOST_STEP_MAX_ROLE_CHARS = 32;
export declare const HOST_STEP_MAX_PROVIDER_CHARS = 64;
export declare const HOST_STEP_MAX_REASON_CHARS = 64;
export declare const HOST_STEP_MAX_DETAIL_CHARS = 200;
export declare const HOST_STEP_MAX_TARGET_CHARS = 128;
export declare const HOST_STEP_MAX_REF_CHARS = 128;
export declare const HOST_STEP_MAX_REPORT_PATH_CHARS = 240;
export declare const HOST_STEP_MAX_COUNT = 32;
/**
 * Validate the persisted host-step contract. This deliberately rejects unknown
 * fields and unbounded values so status and receipt loaders fail closed.
 */
export declare function assertHostStepNode(value: unknown, source?: string): asserts value is HostStepNode;
export declare function parseHostStepNode(value: unknown, source?: string): HostStepNode;
export declare function assertUniqueHostStepIds(hostSteps: readonly HostStepNode[], source?: string): void;
/** Return only valid host nodes so an untrusted in-memory projection fails closed. */
export declare function validHostStepNodes(graph: WorkflowGraphSnapshot | undefined): HostStepNode[];
export declare function assertWorkflowGraphHostSteps(graph: WorkflowGraphSnapshot | undefined, source?: string, expectedRunId?: string): void;
export declare function hostStepWorkflowNode(hostStep: HostStepNode): WorkflowGraphNode;
/**
 * Host-only registration/update boundary. The caller supplies the existing
 * status writer; monitor providers never receive a path or write status.json.
 */
export declare function upsertHostStep(input: {
    status: AsyncStatus;
    hostStep: HostStepNode;
    persist: (status: AsyncStatus) => void;
}): AsyncStatus;
export declare function hostStepVerdictLabel(state: HostStepState, verdict: HostStepVerdict | undefined): string;
export declare function hostStepReportName(reportPath: string | undefined): string | undefined;
//# sourceMappingURL=host-step-status.d.ts.map