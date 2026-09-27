import { splitKnownThinkingSuffix } from "../shared/model-info.js";
import { resolveWatchdogConfig } from "./settings.js";
import { createWatchdogWarningMessage } from "./warning-format.js";
function loadWatchdogLaunchRules(cwd) {
    const result = resolveWatchdogConfig(cwd);
    return result.ok ? result.config.rules : undefined;
}
/** `*` matches any run of characters, `?` one character; anchored, case-sensitive. */
export function watchdogGlobMatch(pattern, value) {
    const source = pattern.split("").map((char) => char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("");
    return new RegExp(`^${source}$`).test(value);
}
function modelMatches(patterns, model) {
    const base = splitKnownThinkingSuffix(model).baseModel;
    return patterns.find((pattern) => watchdogGlobMatch(pattern, model) || watchdogGlobMatch(pattern, base));
}
/** Deny wins over allow; an unknown model cannot be judged. */
export function evaluateLaunchRule(rules, agent, model) {
    const roleRule = rules?.roleModels[agent];
    if (!roleRule || !model)
        return undefined;
    const note = roleRule.note ? ` ${roleRule.note}` : "";
    const denied = roleRule.deny?.length ? modelMatches(roleRule.deny, model) : undefined;
    if (denied !== undefined) {
        return {
            agent,
            summary: `Agent '${agent}' was launched with denied model '${model}'.`,
            evidence: `subagents.watchdog.rules.roleModels.${agent}.deny matches '${denied}'.${note}`,
            recommendedAction: roleRule.allow?.length ? `Use one of: ${roleRule.allow.join(", ")}.` : "Choose a different model for this role.",
        };
    }
    if (!roleRule.allow?.length || modelMatches(roleRule.allow, model) !== undefined)
        return undefined;
    return {
        agent,
        summary: `Agent '${agent}' was launched with model '${model}', which is not in its allowed list.`,
        evidence: `subagents.watchdog.rules.roleModels.${agent}.allow is [${roleRule.allow.join(", ")}].${note}`,
        recommendedAction: `Use one of: ${roleRule.allow.join(", ")}.`,
    };
}
export function ruleViolationWarning(violation) {
    return { severity: "concern", category: "missed-constraint", importance: "high", source: "main", ...violation };
}
export function applyWatchdogLaunchRules(input) {
    const rules = loadWatchdogLaunchRules(input.cwd);
    const violation = evaluateLaunchRule(rules, input.agent, input.model);
    if (!violation)
        return undefined;
    if (rules?.action === "block")
        return `Launch blocked by subagents.watchdog.rules: ${violation.summary}`;
    input.warn?.(violation);
    return undefined;
}
/** For launch paths without a main watchdog runtime (background chain steps). */
export function sendRuleViolationWarning(pi, violation) {
    const warning = ruleViolationWarning(violation);
    pi.sendMessage(createWatchdogWarningMessage(warning, { display: true, details: { state: "displayed", displayedAt: new Date().toISOString() } }), { deliverAs: "steer" });
}
//# sourceMappingURL=rules.js.map