import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeTerminalText } from "../shared/display-text.js";
export const SUPERVISOR_REQUEST_MESSAGE_TYPE = "subagent_supervisor_request";
export const SUPERVISOR_REPLY_ENTRY_TYPE = "subagent_supervisor_reply";
const MAX_FIELD_CHARS = 512;
const MAX_BODY_CHARS = 8_000;
const MAX_INTERVIEW_CHARS = 4_000;
const MAX_RENDER_LINES = 36;
const TRUNCATION_MARKER = "[truncated]";
export function supervisorReplyHint(requestId) {
    return `subagent_supervisor({ action: "reply", replyTo: "${requestId}", message: "..." })`;
}
function boundedText(value, maxChars) {
    const safe = safeTerminalText(value);
    if (safe.length <= maxChars)
        return safe;
    const prefixLength = Math.max(0, maxChars - TRUNCATION_MARKER.length - 1);
    let prefix = "";
    for (const character of safe) {
        if (prefix.length + character.length > prefixLength)
            break;
        prefix += character;
    }
    return `${prefix} ${TRUNCATION_MARKER}`;
}
function displayText(value, maxChars, expanded) {
    return expanded ? safeTerminalText(value) : boundedText(value, maxChars);
}
function boundedField(value, fallback = "unknown") {
    return boundedText(typeof value === "string" ? value : value === undefined ? fallback : String(value), MAX_FIELD_CHARS);
}
function contentText(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => {
        if (!part || typeof part !== "object")
            return "";
        const text = part.text;
        return typeof text === "string" ? text : "";
    })
        .filter(Boolean)
        .join("\n");
}
function interviewText(interview, expanded) {
    let serialized;
    try {
        serialized = JSON.stringify(interview, null, 2) ?? String(interview);
    }
    catch {
        serialized = "[unavailable]";
    }
    return displayText(serialized, MAX_INTERVIEW_CHARS, expanded);
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
function requestDetails(value) {
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
function replyData(value) {
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
function withRequestId(details) {
    return boundedField(details.requestId ?? details.id);
}
function requestHeading(reason) {
    if (reason === "interview_request")
        return "⚠ Supervisor interview request";
    if (reason === "progress_update")
        return "ℹ Supervisor progress update";
    return "⚠ Supervisor decision request";
}
function requestLines(message, details, expanded) {
    const requestId = withRequestId(details);
    const lines = [
        `Reason: ${boundedField(details.reason)}`,
        `Run: ${boundedField(details.runId)}`,
        `Agent: ${boundedField(details.agent)}`,
        `Child index: ${boundedField(details.childIndex)}`,
    ];
    if (details.childTarget)
        lines.push(`Child target: ${boundedField(details.childTarget)}`);
    lines.push(`Request ID: ${requestId}`);
    if (details.expectsReply)
        lines.push(`Reply with: ${displayText(details.replyHint ?? supervisorReplyHint(requestId), MAX_BODY_CHARS, expanded)}`);
    lines.push("", "Request:", displayText((details.requestBody ?? contentText(message.content)) || "(no request body)", MAX_BODY_CHARS, expanded));
    if (details.interview !== undefined)
        lines.push("", "Interview shape:", interviewText(details.interview, expanded));
    return lines;
}
function replyLines(data, expanded) {
    const requestId = boundedField(data.requestId);
    const lines = [
        ...(data.reason ? [`Reason: ${boundedField(data.reason)}`] : []),
        `Run: ${boundedField(data.runId)}`,
        `Agent: ${boundedField(data.agent)}`,
        `Child index: ${boundedField(data.childIndex)}`,
    ];
    if (data.childTarget)
        lines.push(`Child target: ${boundedField(data.childTarget)}`);
    lines.push(`Reply to: ${requestId}`, "", "Reply:", displayText(data.message || "(empty reply)", MAX_BODY_CHARS, expanded));
    return lines;
}
function renderCard(lines, heading, theme, width, expanded) {
    const safeWidth = Math.max(0, Math.floor(width));
    if (safeWidth < 3)
        return [truncateToWidth(heading, safeWidth, "")];
    const bodyWidth = safeWidth - 2;
    const headerText = truncateToWidth(` ${heading} `, bodyWidth, "");
    const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
    const border = (text) => theme.fg("accent", text);
    const rendered = [border(`╭${headerText}${"─".repeat(headerPadding)}╮`)];
    let hidden = false;
    let interiorLines = 0;
    for (const line of lines) {
        const wrapped = wrapTextWithAnsi(line, Math.max(1, bodyWidth));
        for (const wrappedLine of wrapped.length > 0 ? wrapped : [""]) {
            if (!expanded && interiorLines >= MAX_RENDER_LINES) {
                hidden = true;
                break;
            }
            const text = truncateToWidth(wrappedLine, bodyWidth, "");
            rendered.push(border(`│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`));
            interiorLines++;
        }
        if (hidden)
            break;
    }
    if (hidden) {
        const text = truncateToWidth(TRUNCATION_MARKER, bodyWidth, "");
        rendered.push(border(`│${text}${" ".repeat(Math.max(0, bodyWidth - visibleWidth(text)))}│`));
    }
    rendered.push(border(`╰${"─".repeat(bodyWidth)}╯`));
    return rendered;
}
class SupervisorCardComponent {
    expanded;
    heading;
    lines;
    theme;
    constructor(heading, lines, theme, expanded) {
        this.expanded = expanded;
        this.heading = heading;
        this.lines = lines;
        this.theme = theme;
    }
    invalidate() { }
    render(width) {
        return renderCard(this.lines, this.heading, this.theme, width, this.expanded);
    }
}
export function renderSupervisorRequest(message, options, theme) {
    const details = requestDetails(message.details);
    if (!details)
        return undefined;
    return new SupervisorCardComponent(requestHeading(details.reason), requestLines(message, details, options.expanded), theme, options.expanded);
}
export function renderSupervisorReply(entry, options, theme) {
    const data = replyData(entry.data);
    if (!data)
        return undefined;
    return new SupervisorCardComponent("↩ Supervisor reply to child", replyLines(data, options.expanded), theme, options.expanded);
}
//# sourceMappingURL=supervisor-ui.js.map