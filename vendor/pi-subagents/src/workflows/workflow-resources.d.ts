import { type WorkflowResourceHostAuthority, type WorkflowResourcePermit } from "../shared/workflow-child-permit.ts";
import type { WorkflowResourceProvenance } from "../shared/types.ts";
export interface ResolvedWorkflowResource {
    script: string;
    permit: WorkflowResourcePermit;
    provenance: WorkflowResourceProvenance;
}
export type WorkflowResourceResolution = {
    ok: true;
    resource: ResolvedWorkflowResource;
} | {
    ok: false;
    error: string;
};
export interface WorkflowResourceDefinition {
    name: string;
    version: number;
    /** Trusted synchronous validation/expansion. The extension owns semantic command binding. */
    resolve: (args: Readonly<Record<string, unknown>>) => {
        script: string;
        hostCommands?: readonly WorkflowResourceHostAuthority[];
    } | {
        error: string;
    };
}
export interface WorkflowResourceRegistration {
    dispose(): void;
}
export interface RegisterWorkflowResourceInput {
    sessionId: string;
    definition: WorkflowResourceDefinition;
}
/** Session ID scopes lookup, not authentication. Dispose on session_shutdown; issued permits remain valid. */
export declare function registerWorkflowResource(input: RegisterWorkflowResourceInput): WorkflowResourceRegistration;
export declare function normalizeWorkflowArgs(value: unknown): {
    args: Record<string, unknown>;
} | {
    error: string;
};
export declare function deepFreezeWorkflowArgs<T extends Record<string, unknown>>(args: T): Readonly<T>;
/** Resolve only extension-owned resources so policy can distinguish them from raw scripts; caller-provided script text is never consulted. */
export declare function resolveWorkflowResource(nameValue: unknown, argsValue?: unknown, sessionId?: string): WorkflowResourceResolution;
//# sourceMappingURL=workflow-resources.d.ts.map