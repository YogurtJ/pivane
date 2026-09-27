export const AUTHORITY_ACTIONS = [
    "discardWorktree",
    "destructiveCleanup",
    "spawnBudgetGrant",
    "scheduleCreate",
    "stopRun",
    "steerRun",
    "inspectorOpen",
    "projectOpen",
];
const DEFAULT_AUTHORITY_POLICY = {
    discardWorktree: "confirm",
    destructiveCleanup: "confirm",
    spawnBudgetGrant: "confirm",
    scheduleCreate: "auto",
    stopRun: "auto",
    steerRun: "auto",
    inspectorOpen: "auto",
    projectOpen: "confirm",
};
export function resolveAuthorityDecision(input) {
    return input.policy?.[input.action] ?? DEFAULT_AUTHORITY_POLICY[input.action];
}
export function validateAuthorityPolicy(value, label = "config.authorityPolicy") {
    if (value === undefined)
        return undefined;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be a JSON object`);
    }
    const policy = value;
    const allowedActions = new Set(AUTHORITY_ACTIONS);
    for (const [action, decision] of Object.entries(policy)) {
        if (!allowedActions.has(action)) {
            throw new Error(`${label}.${action} is unknown; expected one of ${AUTHORITY_ACTIONS.join(", ")}`);
        }
        if (decision !== "auto" && decision !== "confirm" && decision !== "forbid") {
            throw new Error(`${label}.${action} must be "auto", "confirm", or "forbid"`);
        }
    }
    return policy;
}
//# sourceMappingURL=authority.js.map