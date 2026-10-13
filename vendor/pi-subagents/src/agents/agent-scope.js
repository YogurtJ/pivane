export function resolveExecutionAgentScope(scope) {
    if (scope === "user" || scope === "project" || scope === "both")
        return scope;
    return "both";
}
export function projectScopeRequiresTrustMessage(cwd) {
    return `agentScope: "project" requires project trust. This session declined trust for ${cwd}, so project agents and project subagent settings are ignored. Re-run with agentScope: "user" or approve the project folder.`;
}
//# sourceMappingURL=agent-scope.js.map