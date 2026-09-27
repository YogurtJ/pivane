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
 * provider never loaded: a foreground child never loads the parent's ambient
 * extensions, an explicit `extensions` list keeps a background child from
 * loading them, and a capability ceiling denies extensions to both. The caller
 * keeps the core error intact and appends this explanation, so a genuinely
 * unknown model id still reads as one.
 */
export declare function formatChildModelResolutionDiagnostic(diagnostic: ChildModelResolutionDiagnostic): string;
//# sourceMappingURL=model-resolution-diagnostic.d.ts.map