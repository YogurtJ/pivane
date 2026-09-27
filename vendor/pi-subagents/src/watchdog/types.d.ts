export declare const SUBAGENT_WATCHDOG_WARNING_TYPE = "subagent_watchdog_warning";
export declare const WATCHDOG_WARNING_SEVERITIES: readonly ["concern", "blocker"];
export type WatchdogSeverity = typeof WATCHDOG_WARNING_SEVERITIES[number];
export declare const WATCHDOG_WARNING_CATEGORIES: readonly ["correctness", "missed-constraint", "test-gap", "unsafe-change", "scope-drift", "stale-fact", "loop-risk", "other"];
export type WatchdogCategory = typeof WATCHDOG_WARNING_CATEGORIES[number];
export declare const WATCHDOG_WARNING_IMPORTANCES: readonly ["low", "medium", "high"];
export type WatchdogImportance = typeof WATCHDOG_WARNING_IMPORTANCES[number];
export declare const WATCHDOG_WARNING_SOURCES: readonly ["main", "child", "lsp"];
export type WatchdogWarningSource = typeof WATCHDOG_WARNING_SOURCES[number];
export declare const WATCHDOG_LSP_DIAGNOSTIC_SEVERITIES: readonly ["error", "warning", "info", "hint"];
export type WatchdogLspDiagnosticSeverity = typeof WATCHDOG_LSP_DIAGNOSTIC_SEVERITIES[number];
export declare const WATCHDOG_LSP_STATUSES: readonly ["disabled", "ok", "skipped", "unavailable", "timeout", "failed"];
export type WatchdogLspStatus = typeof WATCHDOG_LSP_STATUSES[number];
export declare const WATCHDOG_RUNTIME_STATUSES: readonly ["idle", "queued", "reviewing", "waiting-at-agent-end", "stale", "failed"];
export type WatchdogRuntimeStatus = typeof WATCHDOG_RUNTIME_STATUSES[number];
export declare const WATCHDOG_WARNING_STATES: readonly ["candidate", "confirmed", "displayed", "stale", "failed", "resolved", "stalemate", "suppressed"];
export type WatchdogWarningState = typeof WATCHDOG_WARNING_STATES[number];
export interface WatchdogWarning {
    severity: WatchdogSeverity;
    importance: WatchdogImportance;
    summary: string;
    evidence: string;
    recommendedAction: string;
    category?: WatchdogCategory;
    source?: WatchdogWarningSource;
    agent?: string;
    runId?: string;
    stale?: boolean;
    state?: WatchdogWarningState;
}
export interface WatchdogWarningDetails extends WatchdogWarning {
    category: WatchdogCategory;
    source: WatchdogWarningSource;
    identity?: string;
    displayedAt?: string;
    error?: string;
    stalemateRepeats?: number;
}
export interface WatchdogWarningMessage {
    customType: typeof SUBAGENT_WATCHDOG_WARNING_TYPE;
    content: string;
    display: boolean;
    details: WatchdogWarningDetails;
}
export interface WatchdogGuidanceConfig {
    watchdogMd: boolean;
}
export interface WatchdogScopeConfig {
    enabled: boolean;
}
export interface WatchdogCadenceConfig {
    everyNTools: number | null;
}
export interface WatchdogEndpointConfig {
    enabled: boolean;
    model?: string;
    thinking?: string | false;
}
export interface WatchdogChildOverrideConfig {
    enabled?: boolean;
    model?: string;
    thinking?: string | false;
    cadence?: Partial<WatchdogCadenceConfig>;
}
export interface WatchdogChildrenConfig extends WatchdogEndpointConfig {
    watchdogTailTimeoutMs: number;
    /** Mid-run cadence for child watchdogs; defaults to the top-level cadence. */
    cadence?: Partial<WatchdogCadenceConfig>;
    overrides: Record<string, WatchdogChildOverrideConfig>;
}
export interface WatchdogLspConfig {
    enabled: boolean;
    timeoutMs: number;
    maxFiles: number;
    maxDiagnostics: number;
}
export interface WatchdogLspDiagnostic {
    path: string;
    line: number;
    column: number;
    severity: WatchdogLspDiagnosticSeverity;
    source: string;
    code?: string;
    message: string;
}
export interface WatchdogLspResult {
    status: WatchdogLspStatus;
    provider?: string;
    checkedPaths: string[];
    skippedPaths: string[];
    diagnostics: WatchdogLspDiagnostic[];
    message?: string;
}
export interface WatchdogLspRuntimeSnapshot extends WatchdogLspResult {
    enabled: boolean;
    diagnosticCount: number;
    freshDiagnosticCount: number;
    updatedAt?: string;
}
export interface WatchdogRoleModelRule {
    allow?: string[];
    deny?: string[];
    note?: string;
}
export interface WatchdogRulesConfig {
    action: "warn" | "block";
    roleModels: Record<string, WatchdogRoleModelRule>;
}
export interface ResolvedWatchdogConfig {
    enabled: boolean;
    /** Main-only, bounded boundary clarification; never enabled for child reviews. */
    clarification: boolean;
    agentEndTimeoutMs: number;
    severityThreshold: WatchdogSeverity;
    maxWarnings: number | null;
    guidance: WatchdogGuidanceConfig;
    /** Consecutive identical boundary warnings before the watchdog stops continuing the run. */
    stalemateRepeats: number;
    scope: WatchdogScopeConfig;
    cadence: WatchdogCadenceConfig;
    main: WatchdogEndpointConfig;
    children: WatchdogChildrenConfig;
    lsp: WatchdogLspConfig;
    rules?: WatchdogRulesConfig;
}
export interface WatchdogSettingsError {
    scope: "user" | "project" | "session";
    path?: string;
    message: string;
}
export interface WatchdogSettingsSource {
    scope: "user" | "project" | "session";
    path?: string;
    exists: boolean;
}
export interface WatchdogSettingsResult {
    ok: boolean;
    config: ResolvedWatchdogConfig;
    errors: WatchdogSettingsError[];
    sources: WatchdogSettingsSource[];
}
//# sourceMappingURL=types.d.ts.map