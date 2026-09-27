/**
 * Optional model-scope enforcement for subagent model resolution.
 *
 * When `subagents.modelScope.enforce` is enabled in settings, a resolved model
 * that does not match any `allow` pattern is rejected. The severity depends on
 * where the model came from: an explicit caller-supplied model (`--model`,
 * tool-call `model`, or a TUI clarify pick) is a hard error, while a model
 * inherited from agent frontmatter / `defaultModel` / the parent session only
 * emits a warning so existing configurations keep working. Optional strict
 * enforcement makes inherited models hard errors too.
 *
 * The decision logic ({@link checkModelScope}) is a pure function of its
 * inputs so it can be unit-tested without touching the filesystem or config.
 */
export interface ModelScopeRule {
    enforce?: boolean;
    /** Reject inherited models outside the allowlist instead of warning. */
    strict?: boolean;
    /** Glob-style allow patterns (only `*` is special), matched against `provider/id`. */
    allow?: string[];
}
export interface ModelScopeConfig extends ModelScopeRule {
    /** Additional restrictions keyed by canonical agent name. */
    agents?: Record<string, ModelScopeRule>;
}
export interface ModelScopeCheckRule extends ModelScopeRule {
    origin?: string;
}
export interface ResolvedModelScope extends ModelScopeCheckRule {
    origin: string;
}
/** Where a resolved model originated, deciding enforcement severity. */
export type ModelSource = "explicit" | "inherited";
export interface ModelScopeViolation {
    /** Resolved model id (without thinking suffix) that fell outside the scope. */
    model: string;
    severity: "warn" | "error";
    message: string;
    allowedPatterns: string[];
    origin: string;
}
/**
 * Test whether a resolved model matches a single allow pattern. Both sides are
 * compared case-insensitively against the full `provider/id` (thinking suffix
 * stripped from the model).
 */
export declare function matchesScopePattern(model: string, pattern: string): boolean;
/**
 * Pure scope decision. Returns a {@link ModelScopeViolation} when the model is
 * out of scope and enforcement is on, otherwise `undefined`. Enforcement with
 * no `allow` list is a no-op (the settings parser rejects that combination, but
 * this stays defensive for callers that build configs programmatically).
 */
export declare function checkModelScope(model: string | undefined, scope: ModelScopeCheckRule | undefined, source: ModelSource): ModelScopeViolation | undefined;
/** Resolve the global and matching agent policies into independent launch-time checks. */
export declare function resolveModelScopesForAgent(config: ModelScopeConfig | undefined, agentName: string, parentModel: {
    provider: string;
    id: string;
} | undefined): ResolvedModelScope[];
/**
 * Validate and normalize a raw `subagents.modelScope` value from settings.
 * Throws a descriptive error for malformed configs (matching the surrounding
 * settings-parsing style). Returns `undefined` when the field is absent.
 */
export declare function parseModelScopeConfig(value: unknown, meta: {
    filePath: string;
}): ModelScopeConfig | undefined;
//# sourceMappingURL=model-scope.d.ts.map