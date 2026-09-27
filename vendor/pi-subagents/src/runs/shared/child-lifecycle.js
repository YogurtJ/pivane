export function projectChildLifecycle(event, terminalAssistantStop = false, state) {
    if (event.type === "compaction_end") {
        if (state)
            state.compactionRetryActive = event.willRetry === true;
        return event.willRetry === true ? "cancel-drain" : "none";
    }
    if (event.type === "agent_start" || event.type === "auto_retry_start" || event.type === "turn_start") {
        if (state)
            state.compactionRetryActive = false;
        return "cancel-drain";
    }
    if (event.type === "agent_end") {
        if (event.willRetry !== true && state)
            state.compactionRetryActive = false;
        return "cancel-drain";
    }
    if (event.type === "agent_settled")
        return state?.compactionRetryActive ? "none" : "start-drain";
    if (terminalAssistantStop)
        return "start-drain";
    return "none";
}
//# sourceMappingURL=child-lifecycle.js.map