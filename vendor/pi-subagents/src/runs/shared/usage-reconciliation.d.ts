import type { Usage } from "../../shared/types.ts";
type UsageMessage = {
    role?: unknown;
    timestamp?: unknown;
    usage?: object;
};
export declare function reconcileAttemptUsage(live: Usage, messages: readonly UsageMessage[], baseline: number): Usage;
export {};
//# sourceMappingURL=usage-reconciliation.d.ts.map