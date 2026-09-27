import { type RunFanoutBudgetDescriptor, type RunFanoutBudgetSnapshot, type RunFanoutRejection } from "../../shared/types.ts";
export declare class RunFanoutLimitError extends Error {
    readonly rejection: RunFanoutRejection;
    readonly snapshot: RunFanoutBudgetSnapshot;
    constructor(rejection: RunFanoutRejection);
}
export declare function createRunFanoutBudget(rootRunId: string, limit: number): RunFanoutBudgetDescriptor;
export declare function validateRunFanoutBudgetDescriptor(value: unknown): RunFanoutBudgetDescriptor;
export declare function writeRunFanoutBudgetDescriptor(asyncDir: string, descriptor: RunFanoutBudgetDescriptor): void;
export declare function readRunFanoutBudgetDescriptor(asyncDir: string | undefined): RunFanoutBudgetDescriptor | undefined;
export declare function getRunFanoutBudgetSnapshot(descriptor: RunFanoutBudgetDescriptor): RunFanoutBudgetSnapshot;
export declare function claimRunFanoutBatch(descriptor: RunFanoutBudgetDescriptor, paths: string[]): RunFanoutBudgetSnapshot;
export declare function claimRunFanoutBatchWithCommit<T>(descriptor: RunFanoutBudgetDescriptor, paths: string[], commit: () => T): T;
export declare function formatRunFanoutBudget(snapshot: RunFanoutBudgetSnapshot): string;
//# sourceMappingURL=run-fanout-budget.d.ts.map