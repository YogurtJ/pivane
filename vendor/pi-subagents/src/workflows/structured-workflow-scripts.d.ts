/**
 * Package-owned workflow scripts for the data-only `tasks` and `chain` inputs.
 * Callers supply only data; every caller string is embedded with JSON.stringify
 * and never becomes code. Scripts run on the ordinary workflow runtime.
 */
export type StructuredWorkflowKind = "tasks" | "chain";
export declare function isPlainRecord(value: unknown): value is Record<string, unknown>;
/** Validate exact data shapes and expand them into a package-owned workflow script. */
export declare function buildStructuredWorkflowScript(kind: StructuredWorkflowKind, steps: unknown, originalTask: string | undefined): string;
//# sourceMappingURL=structured-workflow-scripts.d.ts.map