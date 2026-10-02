import { type ImportedAsyncRootResult } from "./chain-root-attachment.ts";
type ExistingAsyncRunOutcome = {
    status: "settled";
    result: ImportedAsyncRootResult;
} | {
    status: "unavailable";
    reason: string;
};
/**
 * Waits for an existing workflow-awaited async child, identified by its async
 * directory and exact run id, and returns its published result without
 * launching, consuming, or rewriting anything. Anything short of a published
 * result file for that exact run is `unavailable`. Rejects with the signal's
 * reason when aborted.
 */
export declare function awaitExistingAsyncRun(asyncDir: string, runId: string, signal: AbortSignal): Promise<ExistingAsyncRunOutcome>;
/**
 * Renames the published result to a file owned by `claimant`. Only one of several
 * concurrent importers can win the rename; the others get undefined and launch fresh.
 */
export declare function claimWorkflowAwaitedResult(asyncDir: string, claimant: string): string | undefined;
export {};
//# sourceMappingURL=await-async-run.d.ts.map