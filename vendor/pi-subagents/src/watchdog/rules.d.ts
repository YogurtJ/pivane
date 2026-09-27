import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { WatchdogRulesConfig, WatchdogWarning } from "./types.ts";
export interface WatchdogRuleViolation {
    agent: string;
    summary: string;
    evidence: string;
    recommendedAction: string;
}
/** `*` matches any run of characters, `?` one character; anchored, case-sensitive. */
export declare function watchdogGlobMatch(pattern: string, value: string): boolean;
/** Deny wins over allow; an unknown model cannot be judged. */
export declare function evaluateLaunchRule(rules: WatchdogRulesConfig | undefined, agent: string, model: string | undefined): WatchdogRuleViolation | undefined;
export declare function ruleViolationWarning(violation: WatchdogRuleViolation): WatchdogWarning;
export declare function applyWatchdogLaunchRules(input: {
    cwd: string;
    agent: string;
    model?: string;
    warn?: (violation: WatchdogRuleViolation) => void;
}): string | undefined;
/** For launch paths without a main watchdog runtime (background chain steps). */
export declare function sendRuleViolationWarning(pi: Pick<ExtensionAPI, "sendMessage">, violation: WatchdogRuleViolation): void;
//# sourceMappingURL=rules.d.ts.map