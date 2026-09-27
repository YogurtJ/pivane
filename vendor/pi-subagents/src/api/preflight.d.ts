import { type AgentConfig, type AgentScope, type AgentSource } from "../agents/agents.ts";
import { type AvailableModelInfo, type ParentModel } from "../runs/shared/model-resolution.ts";
import { type ThinkingLevel } from "../shared/thinking-ceiling.ts";
import { type ArtifactDirPreference, type ArtifactPaths, type IntercomBridgeConfig, type IntercomBridgeMode, type JsonSchemaObject, type OutputMode } from "../shared/types.ts";
import { type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "../runs/shared/capability-ceiling.ts";
import type { ResolvedMcpDirectToolSelection } from "../runs/shared/mcp-direct-tool-allowlist.ts";
import { AGENT_DEFINITION_PROJECTION_VERSION } from "../shared/launch-contract.ts";
import { type ExtensionBindings } from "../runs/shared/extension-bindings.ts";
export declare const SUBAGENT_LAUNCH_CONTRACT_VERSION: 3;
export type SubagentLaunchContractReasonCode = "missing_agent" | "ambiguous_agent" | "missing_skill" | "denied_required_tool" | "invalid_artifact_dir" | "invalid_cwd" | "unsupported_mode" | "restricted_agent" | "thinking_ceiling" | "invalid_extension_bindings" | "invalid_intercom_bridge";
export type SubagentLaunchContractDiagnosticCode = SubagentLaunchContractReasonCode | "host_required" | "snapshot_warning" | "workspace_scope_authority";
export interface SubagentLaunchContractDiagnostic {
    code: SubagentLaunchContractDiagnosticCode;
    severity: "error" | "warning" | "host-required";
    message: string;
}
export interface SubagentLaunchContractInput {
    agent: string;
    cwd: string;
    task?: string;
    agentScope?: AgentScope;
    context?: "fresh" | "fork";
    model?: string;
    fast?: boolean;
    thinking?: string | false;
    thinkingCeiling?: ThinkingLevel;
    inheritedThinkingCeiling?: ThinkingLevel;
    parentModel?: ParentModel;
    availableModels?: ReadonlyArray<AvailableModelInfo | {
        provider: string;
        id: string;
        fullId?: string;
        reasoning?: boolean;
    }>;
    preferredProvider?: string;
    skill?: string | string[] | boolean;
    output?: string | boolean;
    outputMode?: OutputMode;
    outputSchema?: JsonSchemaObject | false;
    extensionBindings?: ExtensionBindings;
    artifacts?: boolean;
    artifactDir?: ArtifactDirPreference;
    parentSessionFile?: string | null;
    /** Parent session whose host-required child extension snapshot is preflighted. */
    parentSessionId?: string;
    /** Current parent leaf required before an implicit `defaultContext: fork` stays `fork`. */
    parentLeafId?: string | null;
    sessionRoot?: string;
    /** Caller directory used as a root keyed by the child run id ("preflight" placeholder when runId is omitted). */
    sessionDir?: string;
    runId?: string;
    /** Root run id supplied by a host when projecting nested async lifecycle paths. */
    nestedRootRunId?: string;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    inheritedCapabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    /** Per-launch bridge config; replaces the global `intercomBridge` config exactly as the tool and delegation overrides do. */
    intercomBridge?: IntercomBridgeConfig;
    /**
     * Supervisor session target the host will hand to the child. Only a custom
     * bridge instruction file that names the session needs it; the default
     * template is session-independent.
     */
    orchestratorTarget?: string;
}
/** Bridge activation before tool capability ceilings are applied. */
export type SubagentLaunchContractIntercomBridge = {
    active: true;
    mode: Exclude<IntercomBridgeMode, "off">;
} | {
    active: false;
    mode: IntercomBridgeMode;
};
export interface SubagentLaunchContractAgentCandidate {
    name: string;
    localName?: string;
    packageName?: string;
    source: AgentSource;
    filePath: string;
    disabled?: boolean;
    selected: boolean;
}
export interface SubagentLaunchContractAgent {
    name: string;
    localName?: string;
    packageName?: string;
    source: AgentSource;
    filePath: string;
    definitionProjectionVersion: typeof AGENT_DEFINITION_PROJECTION_VERSION;
    definitionDigest: string;
    shadowedCandidates: SubagentLaunchContractAgentCandidate[];
}
export interface SubagentLaunchContractSkills {
    requested: string[];
    resolved: Array<{
        name: string;
        path: string;
        source: string;
    }>;
    missing: string[];
}
export interface SubagentLaunchContractTools {
    requestedBuiltin: string[];
    declaredBuiltin: string[];
    excludeTools?: string[];
    effectiveAllowlist: string[];
    explicitAllowlist: boolean;
    requiredChildTools: string[];
    internalTools: string[];
    mcp: ResolvedMcpDirectToolSelection[];
    effectiveMcpTools: string[];
    toolExtensionPaths: string[];
    runtimeExtensions: string[];
    configuredExtensions: string[];
    requiredExtensionIds: string[];
    extensionArgs: string[];
    disableAmbientExtensions: boolean;
    fanoutAuthorized: boolean;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    capabilityAudit?: SubagentCapabilityAudit;
}
export interface SubagentLaunchContractRoots {
    cwd: string;
    sessionRoot?: string;
    sessionDir?: string;
    sessionFile?: string;
    artifactsDir?: string;
    artifactPaths?: ArtifactPaths;
    outputPath?: string;
    lifecycle?: {
        asyncDir: string;
        resultPath: string;
        statusPath: string;
        eventsPath: string;
        processTerminalPath: string;
        processTerminalCandidatePath: string;
    };
}
export interface SubagentLaunchContract {
    version: typeof SUBAGENT_LAUNCH_CONTRACT_VERSION;
    runId: string;
    agent: SubagentLaunchContractAgent;
    context: "fresh" | "fork";
    model?: string;
    thinking?: string;
    thinkingCeiling?: ThinkingLevel;
    systemPromptMode: AgentConfig["systemPromptMode"];
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    skills: SubagentLaunchContractSkills;
    tools: SubagentLaunchContractTools;
    intercomBridge: SubagentLaunchContractIntercomBridge;
    roots: SubagentLaunchContractRoots;
    protocol: {
        lifecycleArtifactVersion: number;
        packageVersion: string;
    };
    diagnostics: SubagentLaunchContractDiagnostic[];
    /** Digest of the resolved child inputs, recomputed by execution paths. */
    launchContractDigest: string;
    digest: string;
}
export type SubagentLaunchContractResult = {
    ok: true;
    contract: SubagentLaunchContract;
} | {
    ok: false;
    code: SubagentLaunchContractReasonCode;
    message: string;
    diagnostics: SubagentLaunchContractDiagnostic[];
};
export declare function resolveSubagentLaunchContract(input: SubagentLaunchContractInput): Promise<SubagentLaunchContractResult>;
//# sourceMappingURL=preflight.d.ts.map