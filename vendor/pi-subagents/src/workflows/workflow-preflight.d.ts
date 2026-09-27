import type { WorkflowPreflightLane, WorkflowPreflight } from "../shared/types.ts";
export declare const WORKFLOW_PREFLIGHT_VERSION: 1;
export declare const WORKFLOW_PREFLIGHT_MAX_LANES = 64;
export declare const WORKFLOW_PREFLIGHT_MAX_STRING_LENGTH = 256;
export declare const WORKFLOW_PREFLIGHT_MAX_CLAIMS = 16;
export declare const WORKFLOW_PREFLIGHT_MAX_DEPTH = 3;
export declare const WORKFLOW_PREFLIGHT_MAX_BYTES: number;
export declare const WORKFLOW_PREFLIGHT_MAX_WARNINGS = 16;
type WorkflowTraceLike = {
    operation: string;
    key: string;
    phase?: string;
    generatedLaneKey?: string;
    warning?: string;
};
export interface WorkflowPreflightValidationResult {
    ok: boolean;
    preflight?: WorkflowPreflight;
    error?: string;
}
/**
 * Validate and canonicalize the explicit preflight input. This is intentionally
 * independent of workflowScript parsing: callers may describe dynamic fanout
 * without making the metadata a second execution graph.
 */
export declare function normalizeWorkflowPreflight(input: unknown): WorkflowPreflight | undefined;
export declare function validateWorkflowPreflight(input: unknown): WorkflowPreflightValidationResult;
/**
 * Treat declared lane keys as plan roots: `lane` is the lane itself and
 * `lane.stage` is a stage by convention, even without generated provenance.
 */
export declare function workflowKeyMatchesPreflightLane(key: string, laneKey: string, generatedLaneKey?: string): boolean;
/** Select the most specific advisory lane without allowing declaration order to override an exact runtime key. */
export declare function workflowPreflightLaneForRuntimeKey(preflight: WorkflowPreflight | undefined, key: string, preferredKeys?: readonly (string | undefined)[]): WorkflowPreflightLane | undefined;
/** Return bounded advisory mismatch warnings; these never reject a child launch. */
export declare function workflowPreflightWarnings(preflight: WorkflowPreflight | undefined, trace: readonly WorkflowTraceLike[], options?: {
    settled?: boolean;
}): string[];
/** Attach the first undeclared-key warning to its first trace row for status/debug views. */
export declare function annotateWorkflowPreflightTrace<T extends WorkflowTraceLike>(trace: readonly T[], preflight: WorkflowPreflight | undefined): T[];
/** Render the detailed bounded table reserved for tool output and expanded/debug views. */
export declare function formatWorkflowPreflight(preflight: WorkflowPreflight | undefined, options?: {
    indent?: string;
}): string;
export declare function formatWorkflowPreflightSummary(preflight: WorkflowPreflight | undefined): string;
/** Render the operator-facing one-line plan shown in routine status views. */
export declare function formatWorkflowPreflightPlanSummary(preflight: WorkflowPreflight | undefined, options?: {
    indent?: string;
}): string;
/** Render a bounded, non-alarming warning for routine status views. */
export declare function formatWorkflowPreflightWarningSummary(warnings: readonly string[] | undefined, options?: {
    indent?: string;
    hint?: string;
}): string;
export declare function formatWorkflowPreflightWarnings(warnings: readonly string[] | undefined, options?: {
    indent?: string;
}): string;
export {};
//# sourceMappingURL=workflow-preflight.d.ts.map