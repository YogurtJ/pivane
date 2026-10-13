import { type WorkflowResourceHostAuthority, type WorkflowResourcePermit } from "../shared/workflow-child-permit.ts";
import type { WorkflowResourceProvenance } from "../shared/types.ts";
export declare const MAX_ARGS_BYTES: number;
export declare const MAX_ARGS_FIELDS = 16;
export declare const MAX_ARGS_ITEMS = 64;
export declare const MAX_ARGS_DEPTH = 8;
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
/**
 * Expand data-only `tasks` or `chain` input into a package-owned workflow script with a one-use permit.
 * Only the executor calls this, after its own feature and input checks; public named lookup cannot reach it.
 */
export declare function resolveStructuredWorkflowResource(input: {
    kind: "tasks" | "chain";
    steps: unknown;
    task?: unknown;
}): WorkflowResourceResolution;
/** Resolve only extension-owned resources so policy can distinguish them from raw scripts; caller-provided script text is never consulted. */
export declare function resolveWorkflowResource(nameValue: unknown, argsValue?: unknown, sessionId?: string): WorkflowResourceResolution;
//# sourceMappingURL=workflow-resources.d.ts.map