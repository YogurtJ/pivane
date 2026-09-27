export function formatProcessSignalError(signal) {
    return `Subagent process terminated by signal ${signal}.`;
}
export function formatMidToolExitError(input) {
    if (input.exitCode === undefined && !input.processSignal) {
        return `Subagent session ended during '${input.toolName}' tool execution before the tool completed. Earlier assistant output is not a terminal result.`;
    }
    const terminal = [`exit ${input.exitCode ?? "unknown"}`, ...(input.processSignal ? [`signal ${input.processSignal}`] : [])].join(", ");
    return `Subagent process exited during '${input.toolName}' tool execution (${terminal}) before the tool completed. Earlier assistant output is not a terminal result.`;
}
export function isOrdinaryToolForMidToolExit(toolName) {
    return toolName !== "intercom" && toolName !== "contact_supervisor";
}
export function isUnexplainedProcessSignal(input) {
    return Boolean(input.processSignal)
        && input.interrupted !== true
        && input.timedOut !== true
        && input.stopped !== true
        && input.turnBudgetExceeded !== true
        && input.forcedDrainAfterFinalSuccess !== true;
}
//# sourceMappingURL=process-signal.js.map