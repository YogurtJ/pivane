import type { AgentConfig } from "../agents/agents.ts";
import type { ExtensionConfig, IntercomBridgeConfig, IntercomBridgeMode } from "../shared/types.ts";
export declare const NATIVE_INTERCOM_EXTENSION_DIR = "native:pi-subagents-supervisor-channel";
export declare const PI_INTERCOM_SESSION_ID_ENV = "PI_INTERCOM_SESSION_ID";
export declare const INTERCOM_BRIDGE_MARKER = "Intercom orchestration channel:";
export interface IntercomBridgeState {
    active: boolean;
    mode: IntercomBridgeMode;
    resultDelivery: boolean;
    orchestratorTarget?: string;
    extensionDir: string;
    instruction: string;
    /** True when the instruction template names the supervisor session, which ties the child prompt to the parent session. */
    interpolatesOrchestratorTarget: boolean;
}
export type IntercomBridgeConfigValidation = {
    ok: true;
    value: IntercomBridgeConfig;
} | {
    ok: false;
    error: string;
};
/** Validates untrusted bridge config from descriptors or delegation requests; `label` prefixes each error. */
export declare function validateIntercomBridgeConfig({ value, label }: {
    value: unknown;
    label: string;
}): IntercomBridgeConfigValidation;
export interface IntercomBridgeDiagnostic {
    active: boolean;
    mode: IntercomBridgeMode;
    wantsIntercom: boolean;
    supervisorChannelAvailable: boolean;
    extensionDir: string;
    orchestratorTarget?: string;
    reason?: string;
}
interface ResolveIntercomBridgeInput {
    config: ExtensionConfig["intercomBridge"];
    /** Per-run config replaces the global config when supplied. */
    override?: IntercomBridgeConfig;
    context: "fresh" | "fork" | undefined;
    orchestratorTarget?: string;
    cwd?: string;
    settingsDir?: string;
    agentDir?: string;
}
export declare function resolveIntercomSessionTarget(sessionName: string | undefined, sessionId: string, intercomSessionId?: string | undefined): string;
export declare function resolveSubagentIntercomTarget(runId: string, agent: string, index?: number): string;
export declare function resolveIntercomBridgeMode(value: unknown): IntercomBridgeMode;
export declare function diagnoseIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeDiagnostic;
export declare function resolveIntercomBridge(input: ResolveIntercomBridgeInput): IntercomBridgeState;
/**
 * Rewrites the launch prompt and tools for an active bridge. The parsed
 * definition digest is captured first so launch identity keeps describing the
 * agent file rather than this runtime overlay.
 */
export declare function applyIntercomBridgeToAgent(agent: AgentConfig, bridge: IntercomBridgeState): AgentConfig;
export {};
//# sourceMappingURL=intercom-bridge.d.ts.map