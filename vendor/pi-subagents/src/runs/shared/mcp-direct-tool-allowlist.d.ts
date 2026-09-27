import { type McpServerDefinition } from "./mcp-config-sources.ts";
import type { McpToolPrefix, ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-grant.ts";
export { formatUnresolvedMcpDirectToolSelectors } from "./mcp-direct-tool-grant.ts";
export type { ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-grant.ts";
declare const IMPORT_PATHS: {
    readonly cursor: readonly [string];
    readonly "claude-code": readonly [string, string, string];
    readonly "claude-desktop": readonly [string];
    readonly codex: readonly [string];
    readonly windsurf: readonly [string];
    readonly vscode: readonly [".vscode/mcp.json"];
};
type ImportKind = keyof typeof IMPORT_PATHS;
type ServerEntry = McpServerDefinition;
export interface McpConfig {
    mcpServers: Record<string, ServerEntry>;
    imports?: ImportKind[];
    settings?: {
        toolPrefix?: McpToolPrefix;
        directTools?: boolean;
        agentPluginPaths?: unknown;
    };
}
export declare const MCP_RUNTIME_SNAPSHOT_EVENT: "pi-mcp-adapter:runtime-snapshot:v1";
export declare const MCP_RUNTIME_SNAPSHOT_VERSION: 1;
export interface McpRuntimeServerSnapshot {
    readonly name: string;
    readonly definition: ServerEntry;
    readonly runtime: true;
    readonly persisted: false;
}
interface McpRuntimeSnapshotRequest {
    version: typeof MCP_RUNTIME_SNAPSHOT_VERSION;
    name: string;
    result?: {
        ok: true;
        snapshot: McpRuntimeServerSnapshot;
    } | {
        ok: false;
        error: Error;
    };
}
export interface McpRuntimeSnapshotHost {
    events: {
        emit(event: string, request: McpRuntimeSnapshotRequest): void;
    };
}
export interface McpDirectToolResolution {
    selections: ResolvedMcpDirectToolSelection[];
    unresolvedSelectors: string[];
    /** Normal loaded config plus the selected runtime server definitions. */
    mcpConfig?: McpConfig;
    runtimeServerNames?: string[];
}
export declare function resolveMcpDirectToolResolution(mcpDirectTools: string[] | undefined, cwd?: string, runtimeSnapshotHost?: McpRuntimeSnapshotHost, configOverride?: McpConfig): McpDirectToolResolution;
export declare function resolveMcpDirectToolSelections(mcpDirectTools: string[] | undefined, cwd?: string, runtimeSnapshotHost?: McpRuntimeSnapshotHost): ResolvedMcpDirectToolSelection[];
export declare function resolveMcpDirectToolNames(mcpDirectTools: string[] | undefined, cwd?: string): string[];
export declare function computeMcpServerHash(definition: ServerEntry): string;
//# sourceMappingURL=mcp-direct-tool-allowlist.d.ts.map