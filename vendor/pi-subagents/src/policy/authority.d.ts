export declare const AUTHORITY_ACTIONS: readonly ["discardWorktree", "destructiveCleanup", "spawnBudgetGrant", "scheduleCreate", "stopRun", "steerRun", "inspectorOpen", "projectOpen"];
export type AuthorityAction = typeof AUTHORITY_ACTIONS[number];
export type AuthorityDecision = "auto" | "confirm" | "forbid";
export type AuthorityPolicyConfig = Partial<Record<AuthorityAction, AuthorityDecision>>;
export declare function resolveAuthorityDecision(input: {
    action: AuthorityAction;
    policy?: AuthorityPolicyConfig;
}): AuthorityDecision;
export declare function validateAuthorityPolicy(value: unknown, label?: string): AuthorityPolicyConfig | undefined;
//# sourceMappingURL=authority.d.ts.map