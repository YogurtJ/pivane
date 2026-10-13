export const SUPERVISOR_REQUEST_MESSAGE_TYPE = "subagent_supervisor_request";
export const SUPERVISOR_REPLY_ENTRY_TYPE = "subagent_supervisor_reply";
export function supervisorReplyHint(requestId) {
    return `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`;
}
function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSupervisorReason(value) {
    return value === "need_decision" || value === "interview_request" || value === "progress_update";
}
function optionalString(value) {
    return value === undefined || typeof value === "string";
}
export function parseSupervisorRequestDetails(value) {
    if (!isRecord(value))
        return undefined;
    if (!optionalString(value.id) || !optionalString(value.requestId) || !optionalString(value.replyHint) || !optionalString(value.requestBody) || !optionalString(value.runId) || !optionalString(value.agent) || !optionalString(value.childTarget))
        return undefined;
    if (value.reason !== undefined && !isSupervisorReason(value.reason))
        return undefined;
    if (value.expectsReply !== undefined && typeof value.expectsReply !== "boolean")
        return undefined;
    if (value.childIndex !== undefined && (typeof value.childIndex !== "number" || !Number.isFinite(value.childIndex)))
        return undefined;
    return value;
}
export function parseSupervisorReplyData(value) {
    if (!isRecord(value))
        return undefined;
    if (typeof value.requestId !== "string" || typeof value.runId !== "string" || typeof value.agent !== "string" || typeof value.message !== "string")
        return undefined;
    if (value.reason !== undefined && !isSupervisorReason(value.reason))
        return undefined;
    if (value.childTarget !== undefined && typeof value.childTarget !== "string")
        return undefined;
    if (typeof value.childIndex !== "number" || !Number.isFinite(value.childIndex) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt))
        return undefined;
    return {
        requestId: value.requestId,
        ...(value.reason === undefined ? {} : { reason: value.reason }),
        runId: value.runId,
        agent: value.agent,
        childIndex: value.childIndex,
        ...(value.childTarget === undefined ? {} : { childTarget: value.childTarget }),
        message: value.message,
        createdAt: value.createdAt,
    };
}
//# sourceMappingURL=supervisor-ui.js.map