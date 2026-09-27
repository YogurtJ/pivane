export declare const SUBAGENT_CAPABILITY_CEILING_VERSION: 1;
export declare const SUBAGENT_CAPABILITY_CEILING_REGISTRY_KEY = "pi-subagents.capability-ceiling.v1";
export type SubagentCapabilityCeiling = {
    allowedTools: readonly string[];
    allowedAgents?: readonly string[];
    denyExtensions?: boolean;
} | {
    allowedTools?: readonly string[];
    allowedAgents?: readonly string[];
    denyExtensions: boolean;
} | {
    allowedTools?: readonly string[];
    allowedAgents: readonly string[];
    denyExtensions?: boolean;
};
export interface ResolvedSubagentCapabilityCeiling {
    version: typeof SUBAGENT_CAPABILITY_CEILING_VERSION;
    allowedTools?: string[];
    allowedAgents?: string[];
    denyExtensions: boolean;
    sources: string[];
}
export interface SubagentCapabilityAudit {
    ceiling: ResolvedSubagentCapabilityCeiling;
    requestedTools?: string[];
    effectiveTools: string[];
    removedTools: string[];
    excludeTools?: string[];
    internalTools: string[];
    extensionsDenied: boolean;
    removedExtensionCount: number;
    requestedMcpToolCount: number;
    effectiveMcpTools: string[];
    agentAllowed: boolean;
    agentRestrictionSources?: string[];
}
export interface RegisterSubagentCapabilityCeilingOptions {
    sessionId: string;
    source: string;
    ceiling: SubagentCapabilityCeiling;
}
export interface SubagentCapabilityCeilingHandle {
    update(ceiling: SubagentCapabilityCeiling): void;
    dispose(): void;
}
export declare function normalizeCapabilityCeilingAllowedAgents(values: unknown): string[];
export declare function parseSubagentCapabilityCeiling(value: unknown, field?: string): ResolvedSubagentCapabilityCeiling;
export declare function registerSubagentCapabilityCeiling(options: RegisterSubagentCapabilityCeilingOptions): SubagentCapabilityCeilingHandle;
export declare function intersectSubagentCapabilityCeilings(...ceilings: Array<ResolvedSubagentCapabilityCeiling | undefined>): ResolvedSubagentCapabilityCeiling | undefined;
export declare function resolveSubagentCapabilityCeiling(sessionId: string | undefined, inherited?: ResolvedSubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling | undefined;
export declare function resolveCurrentSubagentCapabilityCeiling(sessionId: string | undefined): ResolvedSubagentCapabilityCeiling | undefined;
export declare function isAgentAllowedByCapabilityCeiling(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): boolean;
export declare function capabilityCeilingAgentRestrictionMessage(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): string | undefined;
export declare function assertAgentAllowedByCapabilityCeiling(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): void;
export declare function capabilityCeilingAgentRestrictionSources(ceiling: ResolvedSubagentCapabilityCeiling | undefined): string[] | undefined;
export declare function encodeSubagentCapabilityCeiling(ceiling: ResolvedSubagentCapabilityCeiling | undefined): string | undefined;
export declare function decodeSubagentCapabilityCeiling(value: string | undefined): ResolvedSubagentCapabilityCeiling | undefined;
//# sourceMappingURL=capability-ceiling.d.ts.map