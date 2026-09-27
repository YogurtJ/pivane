export const SUBAGENT_STEERING_MESSAGE_TYPE = "subagent_steering_notice";
export function formatSteeringNotice(details) {
    return [
        `Subagent steering ${details.state}: ${details.runId}`,
        `Request: ${details.requestId}`,
        details.message,
        "Inspect the run status before sending another correction.",
    ].join("\n");
}
export function handleSubagentSteeringNotice(input) {
    if (!input.details || (input.details.state !== "failed" && input.details.state !== "partial" && input.details.state !== "recovered"))
        return;
    if (!input.state.currentSessionId || input.details.currentSessionId !== input.state.currentSessionId)
        return;
    const noticeText = input.details.noticeText ?? formatSteeringNotice(input.details);
    input.pi.sendMessage({
        customType: SUBAGENT_STEERING_MESSAGE_TYPE,
        content: noticeText,
        display: true,
        details: { ...input.details, noticeText },
    }, { triggerTurn: true });
}
//# sourceMappingURL=steering-notices.js.map