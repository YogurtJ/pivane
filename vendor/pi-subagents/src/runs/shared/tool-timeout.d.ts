export declare const TOOL_TIMEOUT_ENV = "PI_SUBAGENT_TOOL_TIMEOUT_MS";
export declare const DEFAULT_FAST_TOOL_TIMEOUT_MS = 300000;
export declare const DEFAULT_FAST_TOOL_TIMEOUT_TOOLS: Set<string>;
/** Tools whose normal job can be to wait for a person or another run. */
export declare const TOOL_TIMEOUT_EXEMPT_TOOLS: Set<string>;
export declare const TOOL_TIMEOUT_ALLOWLIST: Set<string>;
export declare function isToolTimeoutExempt(toolName: string | undefined): boolean;
export declare function defaultToolTimeoutMs(toolName: string | undefined): number | undefined;
export declare function effectiveToolTimeoutMs(toolName: string | undefined, configuredToolTimeoutMs: number | undefined): number | undefined;
export declare function formatToolTimeoutMessage(toolName: string, timeoutMs: number): string;
export declare function toolTimeoutCallKey(event: {
    toolCallId?: unknown;
    toolName?: unknown;
}, fallbackId: number): string;
export interface ToolTimeoutResolutionInput {
    /** Per-call value from the subagent tool params (highest precedence). */
    callValue?: unknown;
    /** Agent frontmatter default (second precedence). */
    agentValue?: number;
    /** Global extension config.toolTimeoutMs (third precedence). */
    configValue?: unknown;
    /** PI_SUBAGENT_TOOL_TIMEOUT_MS environment override (lowest precedence). */
    envValue?: string | undefined;
}
/** Resolve the configured hard timeout. Default fast-tool timeouts apply later per tool name. */
export declare function resolveToolTimeoutMs(input: ToolTimeoutResolutionInput): {
    toolTimeoutMs?: number;
    error?: string;
};
/** Read the environment override without requiring callers to know the name. */
export declare function toolTimeoutFromEnv(env?: NodeJS.ProcessEnv): string | undefined;
//# sourceMappingURL=tool-timeout.d.ts.map