import { type McpRuntimeSnapshotHost, type ResolvedMcpDirectToolSelection } from "./mcp-direct-tool-allowlist.ts";
import { type JsonSchemaObject, type LaunchResolvedChildExtensions } from "../../shared/types.ts";
import type { PermissionRules } from "./permissions.ts";
import { type RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
import { type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "./capability-ceiling.ts";
/** True for the extension files pi-subagents itself installs in child sessions. */
export declare function isSubagentRuntimeExtensionPath(extensionPath: string): boolean;
export declare function deriveForkPromptCacheKey(parentSessionId: string | undefined): string | undefined;
export declare function supervisorChannelDir(runId: string, agent: string, childIndex: number): string;
export declare function applyThinkingSuffix(model: string | undefined, thinking: string | false | undefined, replaceExisting?: boolean): string | undefined;
export interface ResolvePiLaunchToolPlanInput {
    tools?: string[];
    excludeTools?: string[];
    allowNestedSubagents?: boolean;
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    requiredExtensions?: RequiredChildExtensionSnapshot;
    mcpDirectTools?: string[];
    cwd?: string;
    requireReadTool?: boolean;
    structuredOutput?: boolean | {
        schema: JsonSchemaObject;
        schemaPath: string;
        outputPath: string;
    };
    fast?: boolean;
    model?: string;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    agentName?: string;
    permissionRules?: PermissionRules;
    runtimeSnapshotHost?: McpRuntimeSnapshotHost;
}
export interface PiLaunchToolPlan {
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    requestedBuiltinTools: string[];
    declaredBuiltinTools: string[];
    excludeTools: string[];
    toolExtensionPaths: string[];
    resolvedMcpSelections: ResolvedMcpDirectToolSelection[];
    effectiveMcpSelections: ResolvedMcpDirectToolSelection[];
    effectiveMcpTools: string[];
    explicitToolAllowlist: boolean;
    internalTools: string[];
    effectiveToolAllowlist: string[];
    requiredChildTools: string[];
    fanoutAuthorized: boolean;
    runtimeExtensions: string[];
    configuredExtensions: string[];
    requiredExtensions: RequiredChildExtensionSnapshot;
    extensionArgs: string[];
    disableAmbientExtensions: boolean;
    capabilityAudit?: SubagentCapabilityAudit;
    /** Non-fatal launch warnings; they do not change behavior. */
    warnings: string[];
}
/**
 * Children are pi sessions inside the parent or the runner process; a spawned
 * `pi` received extra MCP server definitions as a CLI argument, but a session
 * has no such input. Selecting a server that exists only in pi-mcp-adapter's
 * runtime snapshot therefore cannot work and fails the launch.
 */
export declare function formatRuntimeSnapshotMcpServersError(agentName: string | undefined, serverNames: readonly string[]): string;
export declare function projectLaunchResolvedChildExtensions(toolPlan: Pick<PiLaunchToolPlan, "runtimeExtensions" | "configuredExtensions" | "requiredExtensions" | "extensionArgs" | "disableAmbientExtensions">): LaunchResolvedChildExtensions;
/**
 * Resolve the permission-system extension entry point when installed.
 * Returns the absolute path to the extension's main module, or undefined
 * when the package is not installed. Callers can check `autoInject` config
 * to decide whether to include it in child sessions.
 */
export declare function resolvePermissionSystemExtension(): string | undefined;
export declare function resolvePiLaunchToolPlan(input: ResolvePiLaunchToolPlanInput): PiLaunchToolPlan;
//# sourceMappingURL=child-tool-plan.d.ts.map