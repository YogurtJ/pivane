const usageFields = ["input", "output", "cacheRead", "cacheWrite", "cost"];
const aliases = {
    input: ["input", "inputTokens"],
    output: ["output", "outputTokens"],
    cacheRead: ["cacheRead", "cacheReadTokens"],
    cacheWrite: ["cacheWrite", "cacheWriteTokens"],
};
function validNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
function fieldValue(usage, field) {
    if (!usage)
        return undefined;
    const values = usage;
    if (field === "cost") {
        const direct = validNumber(values.cost);
        if (direct !== undefined)
            return direct;
        const cost = values.cost;
        return cost && typeof cost === "object" && !Array.isArray(cost)
            ? validNumber(cost.total)
            : undefined;
    }
    for (const name of aliases[field]) {
        const value = validNumber(values[name]);
        if (value !== undefined)
            return value;
    }
    return undefined;
}
function validTimestamp(message) {
    const value = message.timestamp;
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.length > 0)
        return value;
    return undefined;
}
export function reconcileAttemptUsage(live, messages, baseline) {
    if (!Number.isInteger(baseline) || baseline < 0 || messages.length < baseline)
        return { ...live };
    const persisted = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
    const complete = { input: true, output: true, cacheRead: true, cacheWrite: true, cost: true };
    let previous;
    for (let index = baseline; index < messages.length; index++) {
        const message = messages[index];
        if (message.role === "assistant") {
            const timestamp = validTimestamp(message);
            const duplicate = previous?.role === "assistant" && timestamp !== undefined && validTimestamp(previous) === timestamp;
            if (!duplicate) {
                persisted.turns++;
                for (const field of usageFields) {
                    const value = fieldValue(message.usage, field);
                    if (value === undefined)
                        complete[field] = false;
                    else
                        persisted[field] += value;
                }
            }
        }
        previous = message;
    }
    if (persisted.turns === 0)
        return { ...live };
    const reconciled = { ...live, turns: persisted.turns };
    for (const field of usageFields) {
        if (complete[field] && Number.isFinite(persisted[field]))
            reconciled[field] = persisted[field];
    }
    return reconciled;
}
//# sourceMappingURL=usage-reconciliation.js.map