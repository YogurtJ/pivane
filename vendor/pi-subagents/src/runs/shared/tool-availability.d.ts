export interface ChildToolDiagnostic {
    agent?: string;
    required: string[];
    available: string[];
    missing: string[];
    missingMcpDirectTools?: string[];
}
/**
 * Explain missing child tools. Foreground children run inside the parent
 * process and never load the parent's ambient extensions, so tools an ambient
 * extension registers (MCP tools, provider tools) only exist for background
 * children; the diagnostic says so instead of reporting a generic gap.
 */
export declare function formatChildToolDiagnostic(diagnostic: ChildToolDiagnostic, options?: {
    host?: "parent" | "runner";
}): string;
//# sourceMappingURL=tool-availability.d.ts.map