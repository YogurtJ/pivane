import type { TokenUsage } from "../../shared/types.ts";
type RetainedChildState = "complete" | "failed" | "paused" | "stopped";
type RetainedChildResumability = {
    state: "resumable";
    sessionPath: string;
} | {
    state: "not-resumable";
    reason: string;
};
export interface RetainedChild {
    runId: string;
    parentRunId?: string;
    workflowKey?: string;
    state: RetainedChildState;
    agent: string;
    taskSummary: string;
    completedAt: number;
    resumability: RetainedChildResumability;
    sessionPath?: string;
    tokenTotals?: TokenUsage;
}
export declare function listRetainedChildren(asyncDirRoot: string, sessionId: string): RetainedChild[];
export declare function formatRetainedChildren(children: RetainedChild[]): string;
export {};
//# sourceMappingURL=retained-children.d.ts.map