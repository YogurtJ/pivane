export type McpToolPrefix = "server" | "none" | "short" | "mcp";
export interface McpGrantServerFacts {
    readonly exposeResources?: boolean;
    readonly includeTools?: readonly unknown[];
    readonly excludeTools?: readonly unknown[];
    /** Per-server prefix override, matching the adapter's `ServerEntry.toolPrefix`. */
    readonly toolPrefix?: unknown;
}
export interface McpGrantToolMetadata {
    readonly name?: string;
}
export interface McpGrantResourceMetadata {
    readonly name?: string;
    readonly uri?: string;
}
export interface McpGrantServerMetadata {
    readonly tools?: readonly McpGrantToolMetadata[];
    readonly resources?: readonly McpGrantResourceMetadata[];
}
export interface McpDirectToolGrantInput {
    readonly selectors?: readonly string[];
    readonly servers: Readonly<Record<string, McpGrantServerFacts>>;
    /** Cache entries already validated by the source-loading adapter. */
    readonly metadata: Readonly<Record<string, McpGrantServerMetadata>>;
    readonly toolPrefix?: unknown;
}
export interface ResolvedMcpDirectToolSelection {
    name: string;
    selector: string;
}
export interface McpDirectToolGrant {
    selections: ResolvedMcpDirectToolSelection[];
    unresolvedSelectors: string[];
}
export declare function normalizeMcpDirectToolSelectors(selectors: readonly string[] | undefined): string[];
export declare function parseMcpDirectToolSelectors(selectors: readonly string[]): {
    servers: Set<string>;
    tools: Map<string, Set<string>>;
};
export declare function planMcpDirectToolGrant(input: McpDirectToolGrantInput): McpDirectToolGrant;
export declare function normalizeMcpToolPrefix(value: unknown): McpToolPrefix;
export declare function formatUnresolvedMcpDirectToolSelectors(selectors: readonly string[]): string;
//# sourceMappingURL=mcp-direct-tool-grant.d.ts.map