import type { ChildWatchdogConfig, ChildWatchdogStatusEvent } from "../../watchdog/child-status.ts";
import type { ThinkingLevel } from "../../shared/model-info.ts";
import { type LaunchResolvedChildExtensions, type ResolvedToolBudget, type RunFanoutBudgetDescriptor, type HerdrMachineReference } from "../../shared/types.ts";
import type { McpRuntimeSnapshotHost } from "./mcp-direct-tool-allowlist.ts";
import type { PermissionRules } from "./permissions.ts";
import type { StructuredOutputRuntime } from "./structured-output.ts";
import type { ChildToolDiagnostic } from "./tool-availability.ts";
import type { RuntimeAcknowledgedChildExtensions } from "../../shared/types.ts";
import { type ExtensionBindings } from "./extension-bindings.ts";
import { type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "./capability-ceiling.ts";
import { type PiLaunchToolPlan } from "./child-tool-plan.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import type { ChildSessionLaunch } from "./child-session.ts";
import { type RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
/** Environment variable pi-mcp-adapter reads for the tools a child may expose. */
export declare const MCP_DIRECT_TOOLS_ENV = "MCP_DIRECT_TOOLS";
/**
 * The parts of the launching executor's own child runtime that a child it
 * launches inherits. Serialized into the background runner config; the
 * foreground path passes the executor's full `ChildRuntimeConfig`.
 */
export type InheritedChildRuntime = Pick<ChildRuntimeConfig, "depth" | "maxDepth" | "nestedRoute" | "nestedParent" | "capabilityCeiling" | "thinkingCeiling" | "runFanoutBudget" | "requiredExtensions">;
export declare function inheritedChildRuntime(config: ChildRuntimeConfig | undefined): InheritedChildRuntime | undefined;
export interface BuildInProcessChildLaunchInput {
    machine?: HerdrMachineReference;
    remoteSkillNames?: string[];
    remoteReads?: string[] | false;
    parentSessionId?: string;
    forkCacheKey?: string;
    sessionEnabled: boolean;
    sessionDir?: string;
    sessionFile?: string;
    /** Model reference with the thinking suffix already applied. */
    model?: string;
    systemPromptMode?: "append" | "replace";
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    requireReadTool?: boolean;
    tools?: string[];
    excludeTools?: string[];
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    /** Serialized launch snapshot; omitted only for a top-level parent-process lookup. */
    requiredExtensions?: RequiredChildExtensionSnapshot;
    systemPrompt?: string | null;
    mcpDirectTools?: string[];
    extensionBindings?: ExtensionBindings;
    cwd: string;
    intercomSessionName?: string;
    sessionName?: string;
    orchestratorIntercomTarget?: string;
    runId?: string;
    childAgentName: string;
    childIndex: number;
    nestedRoute?: {
        rootRunId: string;
        eventSink: string;
        controlInbox: string;
        capabilityToken: string;
    };
    runFanoutBudget?: RunFanoutBudgetDescriptor;
    structuredOutput?: StructuredOutputRuntime;
    fast?: boolean;
    toolBudget?: ResolvedToolBudget;
    permissionRules?: PermissionRules;
    permissionAuditPath?: string;
    childWatchdog?: ChildWatchdogConfig;
    watchdogStatus?: (event: ChildWatchdogStatusEvent) => void;
    waitToolEnabled?: boolean;
    waitToolDefaultTimeoutMs?: number;
    allowNestedSubagents?: boolean;
    descendantAllowedAgents?: string[];
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    thinkingCeiling?: ThinkingLevel;
    maxSubagentDepth?: number;
    runtimeSnapshotHost?: McpRuntimeSnapshotHost;
    /** The launching executor's own child runtime when it is itself an in-process child. */
    inherited?: InheritedChildRuntime;
    /**
     * Which process hosts the session. The parent never loads ambient extensions
     * or writes child environment values (it shares its process with the parent
     * session); the runner loads ambient extensions when the tool plan allows
     * them and exposes the child environment external extensions read.
     */
    host: "parent" | "runner";
}
export interface InProcessChildCapture {
    structuredOutput(): {
        called: boolean;
        value?: unknown;
        acceptanceReport?: unknown;
        acceptanceReportProvided: boolean;
    };
    toolDiagnostic(): ChildToolDiagnostic | undefined;
    runtimeAcknowledgedExtensions(): RuntimeAcknowledgedChildExtensions | undefined;
    finalDrainHeld(): boolean;
}
export interface InProcessChildLaunch {
    toolPlan: PiLaunchToolPlan;
    config: ChildRuntimeConfig;
    session: Omit<ChildSessionLaunch, "onExtensionError">;
    capture: InProcessChildCapture;
    launchResolvedExtensions: LaunchResolvedChildExtensions;
    warnings: string[];
    capabilityAudit?: SubagentCapabilityAudit;
}
/** Actual host create-input boundary. Evidence remains explicitly opt-in and dormant in production. */
export declare function createReportedChildSessionInput(launch: InProcessChildLaunch, transcriptWriter?: ChildTranscriptWriter): ChildSessionLaunch;
export declare function buildInProcessChildLaunch(input: BuildInProcessChildLaunchInput): InProcessChildLaunch;
//# sourceMappingURL=child-launch.d.ts.map