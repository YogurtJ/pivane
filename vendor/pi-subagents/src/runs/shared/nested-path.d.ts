export declare const MAX_NESTED_PATH_ENTRIES = 4;
export type NestedPathEntry = {
    runId: string;
    stepIndex?: number;
    agent?: string;
};
export declare function isSafeNestedPathId(value: unknown): value is string;
export declare function sanitizeNestedPath(value: unknown): NestedPathEntry[];
//# sourceMappingURL=nested-path.d.ts.map