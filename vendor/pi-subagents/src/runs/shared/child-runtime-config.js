/**
 * Set in processes that host child sessions (the async runner). The extension
 * entry point registers nothing when it sees it, so an ambient copy of
 * pi-subagents loaded into a child session stays inert.
 */
export const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
/** Root parent session id the parent publishes for pi-permission-system ask forwarding. */
export const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
export function childSupervisorMetadata(config) {
    if (!config.supervisorChannelDir || !config.runId || !config.agent || !config.orchestratorSessionId || config.childIndex === undefined)
        return undefined;
    return {
        channelDir: config.supervisorChannelDir,
        runId: config.runId,
        agent: config.agent,
        childIndex: config.childIndex,
        ...(config.orchestratorTarget ? { orchestratorTarget: config.orchestratorTarget } : {}),
        orchestratorSessionId: config.orchestratorSessionId,
        ...(config.intercomSessionName ? { childTarget: config.intercomSessionName } : {}),
    };
}
/** Compute the child tool-availability diagnostic; undefined when every required tool is present. */
export function evaluateChildToolDiagnostic(config, availableTools) {
    if (!config.requiredTools)
        return undefined;
    const available = new Set(availableTools);
    const missing = config.requiredTools.filter((name) => !available.has(name));
    if (missing.length === 0)
        return undefined;
    const missingMcpDirectTools = config.mcpDirectTools?.length ? missing.filter((name) => config.mcpDirectTools.includes(name)) : [];
    return {
        ...(config.agent ? { agent: config.agent } : {}),
        required: config.requiredTools,
        available: availableTools,
        missing,
        ...(missingMcpDirectTools.length > 0 ? { missingMcpDirectTools } : {}),
    };
}
//# sourceMappingURL=child-runtime-config.js.map