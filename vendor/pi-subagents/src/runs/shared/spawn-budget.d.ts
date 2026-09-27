import { type ExtensionConfig, type SpawnBudgetSnapshot, type SubagentState } from "../../shared/types.ts";
export declare function getSpawnBudgetSnapshot(state: SubagentState, config: ExtensionConfig, sessionId?: string | null): SpawnBudgetSnapshot;
export declare function formatSpawnBudgetSummary(snapshot: SpawnBudgetSnapshot): string;
export declare function formatSpawnBudget(snapshot: SpawnBudgetSnapshot): string;
export declare function preflightSpawnBudget(state: SubagentState, config: ExtensionConfig, sessionId: string | null, requested: number): {
    snapshot: SpawnBudgetSnapshot;
    error?: string;
};
export declare function reserveSpawnBudget(state: SubagentState, config: ExtensionConfig, sessionId: string | null, requested: number): {
    snapshot: SpawnBudgetSnapshot;
    error?: string;
};
export declare function preflightSpawnBudgetGrant(state: SubagentState, config: ExtensionConfig, sessionId: string, additional: number): {
    snapshot: SpawnBudgetSnapshot;
    error?: string;
};
export declare function grantSpawnBudget(state: SubagentState, config: ExtensionConfig, sessionId: string, additional: number, now?: number): {
    snapshot: SpawnBudgetSnapshot;
    error?: string;
};
//# sourceMappingURL=spawn-budget.d.ts.map