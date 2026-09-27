export type ContextMode = "fresh" | "fork";
export type ContextSummary = ContextMode | "mixed";
export declare function isContextMode(value: unknown): value is ContextMode;
export declare function isContextSummary(value: unknown): value is ContextSummary;
export declare function summarizeContextModes(modes: Array<ContextMode | undefined>): ContextSummary | undefined;
export declare function contextModeLabel(mode: ContextMode | ContextSummary | undefined): string;
export declare function contextModeBadge(theme: {
    fg(name: string, text: string): string;
}, mode: ContextMode | ContextSummary | undefined): string;
export declare function contextModePrefix(theme: {
    fg(name: string, text: string): string;
}, mode: ContextMode | ContextSummary | undefined): string;
//# sourceMappingURL=context-mode.d.ts.map