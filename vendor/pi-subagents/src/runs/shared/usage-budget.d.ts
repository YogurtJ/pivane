import type { CostSummary, UsageBudgetConfig, UsageBudgetState } from "../../shared/types.ts";
export declare function validateUsageBudgetConfig(value: unknown, label?: string): {
    budget?: UsageBudgetConfig;
    error?: string;
};
export declare function usageBudgetState(config: UsageBudgetConfig | undefined, totals: CostSummary | undefined): UsageBudgetState | undefined;
export declare function usageBudgetExceededMessage(state: UsageBudgetState): string;
//# sourceMappingURL=usage-budget.d.ts.map