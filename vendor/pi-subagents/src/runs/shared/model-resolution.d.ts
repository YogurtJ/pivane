import { splitKnownThinkingSuffix as splitThinkingSuffix, type ModelInfo as AvailableModelInfo } from "../../shared/model-info.ts";
import { type ModelScopeCheckRule, type ModelScopeViolation, type ModelSource } from "./model-scope.ts";
export type { AvailableModelInfo };
export interface ModelSelectionEvidence {
    model?: string;
    requestedModel?: string;
}
export { splitThinkingSuffix };
/** Aliases apply only to the resolved launch candidate (without its thinking suffix) and the exact raw response ID. */
export declare function formatSubagentModelVerificationError(expectedModel: string, observedModel: string, availableModels: AvailableModelInfo[] | undefined, modelResponseAliases?: Record<string, string[]>): string | undefined;
/** Sentinel model value requesting that a subagent inherit the parent session's model. */
export declare const INHERIT_MODEL = "inherit";
/** Minimal shape of the parent session's in-memory model (`ctx.model`). */
export interface ParentModel {
    provider: string;
    id: string;
}
export declare function normalizeParentModel(model: unknown): ParentModel | undefined;
/**
 * Normalize a model id or provider segment for fuzzy comparison: case-fold,
 * treat dots/underscores as dashes (so `4.5` matches `4-5`), and collapse
 * repeated separators.
 */
export declare function normalizeModelSegment(segment: string): string;
/**
 * Fuzzy-resolve a base model id (thinking suffix already stripped) against the
 * registry, tolerating separator, case, and optional date-stamp differences so
 * users do not have to spell provider/model exactly. A slash is a provider
 * prefix only when that prefix is a registered provider; otherwise the whole
 * string is the model id (Hugging Face `owner/name`). A qualified provider
 * query only matches within the named provider — this never silently switches
 * providers for security/cost-sensitive configs. Returns the matched `fullId`,
 * or `undefined` when there is no match or the match is ambiguous across
 * providers (and no `preferredProvider` disambiguates).
 */
export declare function fuzzyResolveModel(baseModel: string, availableModels: AvailableModelInfo[], preferredProvider?: string): string | undefined;
/**
 * Resolve a possibly-loose model id to a canonical `provider/id` (plus any
 * thinking suffix). Exact registry matches win; fuzzy normalization
 * (separator/case/date-stamp via {@link fuzzyResolveModel}) is a fallback so
 * spelling differences still resolve. Never switches providers for a qualified
 * query.
 */
export declare function resolveModelCandidate(model: string | undefined, availableModels: AvailableModelInfo[] | undefined, preferredProvider?: string): string | undefined;
export interface ResolveSubagentModelOverrideOptions {
    /** When set with `enforce: true`, out-of-scope models are rejected. */
    scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
    /** Origin of the requested model: explicit caller-supplied (hard error) vs inherited (warn). Defaults to `"inherited"`. */
    source?: ModelSource;
    /** Called for warn-severity violations instead of `console.warn`. */
    onWarn?: (violation: ModelScopeViolation) => void;
}
/**
 * Resolve the `--model` override passed to a spawned subagent.
 *
 * When no model is requested (`undefined`, `false`, empty, or the `"inherit"`
 * sentinel), the child must inherit the parent session's *in-memory* model
 * (`provider/id`) instead of being left to resolve its own model. Without an
 * explicit `provider/id`, the child falls back to the global
 * `~/.pi/agent/settings.json` default, which is shared across every open PI
 * session — so a different session that last changed its model in the TUI would
 * silently contaminate this session's subagents (see issue #266). Passing an
 * explicit `provider/id` keeps each session's children isolated to that
 * session's model.
 *
 * An explicitly requested model string is resolved via {@link resolveModelCandidate}.
 * When `options.scope.enforce` is on, an out-of-scope resolved model throws for
 * an explicit (`source: "explicit"`) request and warns for an inherited one,
 * unless strict scope enforcement makes inherited violations hard errors.
 */
export declare function resolveSubagentModelOverride(requestedModel: string | boolean | undefined, parentModel: ParentModel | undefined, availableModels: AvailableModelInfo[] | undefined, preferredProvider?: string, options?: ResolveSubagentModelOverrideOptions): string | undefined;
export declare function resolveEffectiveSubagentModel(explicitModel: string | boolean | undefined, agentModel: string | boolean | undefined, parentModel: ParentModel | undefined, availableModels: AvailableModelInfo[] | undefined, preferredProvider?: string, options?: ResolveSubagentModelOverrideOptions): string | undefined;
export type ModelOrigin = ModelSource | "configured";
export interface ResolveModelSelectionOptions {
    scope?: ModelScopeCheckRule | ModelScopeCheckRule[];
    onWarn?: (violation: ModelScopeViolation) => void;
    /** The primary model came from the running parent session, not configuration. */
    primaryModelFromParent?: boolean;
    /** How the model was selected. */
    origin?: ModelOrigin;
}
export declare function resolveModelOrigin(input: {
    explicitModel?: string | boolean;
    agentModel?: string | boolean;
    parentModel?: ParentModel;
    fromParent?: boolean;
    storedOrigin?: ModelOrigin;
}): ModelOrigin;
export declare function inheritsParentModel(explicitModel: string | boolean | undefined, agentModel: string | boolean | undefined, parentModel: ParentModel | undefined): boolean;
export declare function resolveModelSelection(model: string | undefined, availableModels: AvailableModelInfo[] | undefined, preferredProvider?: string, options?: ResolveModelSelectionOptions): ModelSelectionEvidence;
export declare function isContextOverflow(error: string | undefined): boolean;
//# sourceMappingURL=model-resolution.d.ts.map