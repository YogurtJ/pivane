import { extractTextFromContent } from "../../shared/utils.js";
function isAssistant(message) {
    return !!message && typeof message === "object" && message.role === "assistant";
}
function isErroredAssistant(message) {
    const { stopReason, errorMessage } = message;
    return stopReason === "error" || (typeof errorMessage === "string" && errorMessage.length > 0);
}
export function createPartialOutputTracker() {
    // Only a reference is kept per event; text is extracted once, when a child ends abnormally.
    let latest;
    return {
        observe(event) {
            if ((event.type !== "message_update" && event.type !== "message_end") || !isAssistant(event.message))
                return;
            // A completed reply, including a tool-only one, is already part of the final output.
            // A provider-error message is skipped there, so its text is the newest unfinished text.
            latest = event.type === "message_update" || isErroredAssistant(event.message) ? event.message : undefined;
        },
        text() {
            const text = extractTextFromContent(latest?.content);
            return text.trim() ? text : undefined;
        },
    };
}
export function formatPartialOutput(text, cause) {
    return `Partial output before ${cause}:\n${text}`;
}
/**
 * Summary of a timed-out background run. The timeout message comes first; when a child kept text streamed before
 * the kill, the per-child summary follows, so the completion notice and status show it (capped, with its file path).
 */
export function timedOutRunSummary(message, summary, results) {
    return results.some((result) => result.outputPartial === true) ? `${message}\n\n${summary}` : message;
}
//# sourceMappingURL=partial-output.js.map