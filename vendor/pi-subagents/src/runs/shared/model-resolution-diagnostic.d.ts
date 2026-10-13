export interface ChildModelResolutionDiagnostic {
    agent?: string;
    model?: string;
    host?: "parent" | "runner";
    /** The launch's resolved capability ceiling, when one is active. */
    capabilityCeiling?: {
        denyExtensions: boolean;
        sources?: readonly string[];
    };
}
/** True for a core model-resolution failure, which a missing extension can explain. */
export declare function isChildModelResolutionFailure(error: string | undefined): boolean;
/**
 * Explain a child model that did not resolve because the extension serving its
 * provider, or registering it as a virtual model, never loaded: a foreground
 * child never loads the parent's ambient extensions, an explicit `extensions`
 * list keeps a background child from loading them, and a capability ceiling
 * denies extensions to both. A foreground child inherits the parent's
 * providers but not its virtual models, so only the loaded extension can
 * register one. The caller keeps the core error intact and appends this
 * explanation, so a genuinely unknown model id still reads as one.
 */
export declare function formatChildModelResolutionDiagnostic(diagnostic: ChildModelResolutionDiagnostic): string;
/**
 * Explain a local foreground child that failed before any successful response
 * on a provider it inherited from the parent's registry. The child got the
 * provider but not the parent extension that registered it, so a provider that
 * depends on that extension's session hooks can reject the child's requests.
 * Whether this provider does is unknown here, hence the conditional wording.
 */
export declare function formatInheritedProviderDiagnostic(diagnostic: ChildModelResolutionDiagnostic & {
    provider: string;
}): string;
//# sourceMappingURL=model-resolution-diagnostic.d.ts.map