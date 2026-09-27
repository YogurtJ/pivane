import type { NestedRunSummary } from "../../shared/types.ts";
export interface NestedRunCounts {
    total: number;
    running: number;
    paused: number;
    complete: number;
    failed: number;
    partial: number;
    rejected: number;
    stopped: number;
    queued: number;
}
export declare function countNestedRuns(children: NestedRunSummary[] | undefined): NestedRunCounts;
export declare function formatNestedAggregate(children: NestedRunSummary[] | undefined): string | undefined;
export declare function formatNestedRunStatusLines(children: NestedRunSummary[] | undefined, options?: {
    indent?: string;
    maxDepth?: number;
    maxLines?: number;
    commandHints?: boolean;
}): string[];
//# sourceMappingURL=nested-render.d.ts.map