import type { WorkflowResourceProvenance } from "./types.ts";
export interface WorkflowChildPermitInput {
    issuerPackage: string;
    workflowRunId: string;
    childKey: string;
    agent: string;
    launchContractDigest: string;
    context: "fresh" | "fork";
}
export interface WorkflowChildPermitLaunch {
    workflowRunId: string;
    childKey: string;
    agent: string;
    launchContractDigest: string;
    context: "fresh" | "fork";
    runner: "pi";
}
export interface WorkflowChildPermitContext {
    permit: WorkflowChildPermit;
    workflowRunId: string;
    childKey: string;
}
export interface WorkflowChildPermit {
    readonly __workflowChildPermit: unique symbol;
}
/** Package-internal first-slice permit. It is opaque, in-memory, and not serializable. */
export declare function createWorkflowChildPermit(input: WorkflowChildPermitInput): WorkflowChildPermit;
export declare function validateWorkflowChildPermitRoot(permit: WorkflowChildPermit, workflowRunId: string): string | undefined;
/** Claim the first distinct launch attempt before validating its model-authored shape. */
export declare function claimWorkflowChildPermit(permit: WorkflowChildPermit, workflowRunId: string, childKey: string): string | undefined;
/** Verify and permanently consume the permit before the one native process spawn. */
export declare function consumeWorkflowChildPermit(permit: WorkflowChildPermit, launch: WorkflowChildPermitLaunch): string | undefined;
export declare function workflowChildPermitConsumed(permit: WorkflowChildPermit): boolean;
export interface WorkflowResourceHostAuthority {
    key: string;
    command: string;
}
export interface WorkflowResourceAuthority {
    host?: readonly WorkflowResourceHostAuthority[];
}
export interface WorkflowResourcePermitInput {
    resourceName: string;
    resourceVersion: number;
    resourceId: string;
    scriptDigest: string;
    authority: WorkflowResourceAuthority;
}
export interface WorkflowResourcePermit {
    readonly __workflowResourcePermit: unique symbol;
}
/** Package-internal permit for a workflow resource resolved by the extension. */
export declare function createWorkflowResourcePermit(input: WorkflowResourcePermitInput): WorkflowResourcePermit;
export declare function consumeWorkflowResourcePermit(permit: WorkflowResourcePermit, script: string): {
    provenance: WorkflowResourceProvenance;
    authority: WorkflowResourceAuthority;
} | string;
/** Validate a host call against the authority attached to a consumed resource. */
export declare function authorizeWorkflowResourceHost(permit: WorkflowResourcePermit, key: string, command: string): string | undefined;
//# sourceMappingURL=workflow-child-permit.d.ts.map