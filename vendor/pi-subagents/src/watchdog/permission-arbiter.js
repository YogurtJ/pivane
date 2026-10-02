import { Agent } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendPermissionAudit, permissionArgsPreview } from "../runs/shared/permissions.js";
import { agentStreamOptions } from "../shared/agent-stream-options.js";
import { opencodeSessionHeaders } from "../shared/opencode-session-headers.js";
import { decodeChildWatchdogConfig } from "./child-status.js";
import { childResolvedConfig } from "./register-child.js";
import { formatWatchdogCwdSection, resolveWatchdogReviewModel } from "./review.js";
const PermissionDecisionParams = Type.Object({
    decision: Type.String({ enum: ["approve", "deny"] }),
    reason: Type.String({ description: "One concise reason for this exact decision." }),
}, { additionalProperties: false });
function conciseReason(value) {
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 500) : "Watchdog returned an empty reason.";
}
export function createWatchdogPermissionArbiter(options = {}) {
    return async (request) => {
        const preview = permissionArgsPreview(request.args);
        const createdAt = Date.now();
        const auditBase = { type: "permission.request", createdAt, toolName: request.toolName, preview, matchedRule: "ask", decisionSource: "watchdog" };
        appendPermissionAudit(request.auditPath, auditBase);
        let completed = false;
        const finish = (approved, reason, decision) => {
            const concise = conciseReason(reason);
            if (completed)
                return { approved, reason: concise, source: "watchdog" };
            completed = true;
            appendPermissionAudit(request.auditPath, {
                type: "permission.decision",
                createdAt: Date.now(),
                requestCreatedAt: createdAt,
                toolName: request.toolName,
                decision,
                approved,
                decisionSource: "watchdog",
                reason: concise,
            });
            return { approved, reason: concise, source: "watchdog" };
        };
        let childConfig;
        try {
            childConfig = decodeChildWatchdogConfig(request.rawWatchdogConfig);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return finish(false, `Watchdog permission arbiter configuration is invalid: ${reason}`, "unavailable");
        }
        if (!childConfig)
            return finish(false, "Watchdog permission arbiter is unavailable because the child watchdog is disabled.", "unavailable");
        if (request.signal?.aborted || request.ctx.signal?.aborted)
            return finish(false, "Watchdog permission decision was cancelled.", "cancelled");
        let decision;
        const tool = {
            name: "watchdog_permission_decision",
            label: "Watchdog permission decision",
            description: "Approve or deny this exact child tool call. Call exactly once.",
            parameters: PermissionDecisionParams,
            executionMode: "sequential",
            async execute(_toolCallId, params) {
                if (!decision)
                    decision = params;
                return { content: [{ type: "text", text: "Permission decision recorded." }], details: { recorded: true } };
            },
        };
        let timeout;
        let agent;
        let abort;
        try {
            const run = async () => {
                const config = childResolvedConfig(childConfig);
                const selection = await resolveWatchdogReviewModel(request.ctx, config);
                const auth = selection.auth;
                const sessionId = request.ctx.sessionManager.getSessionId();
                const baseStreamFn = options.streamFn ?? ((model, context, streamOptions) => request.ctx.modelRegistry.streamSimple(model, context, streamOptions));
                const streamFn = (model, context, streamOptions) => baseStreamFn(model, context, {
                    ...streamOptions,
                    ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
                    env: auth.env || streamOptions?.env ? { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } : undefined,
                    headers: { ...opencodeSessionHeaders(model, sessionId), ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
                });
                const systemPrompt = [
                    "You are the pi-subagents watchdog permission arbiter.",
                    "Decide only whether this exact non-bash child tool call should proceed.",
                    "Call watchdog_permission_decision exactly once with approve or deny and a concise reason.",
                    "Deny when uncertain. Do not produce freeform advice or ask the parent orchestrator.",
                    "",
                    formatWatchdogCwdSection(request.ctx.cwd),
                ].join("\n");
                const tools = [tool];
                agent = new Agent({
                    initialState: {
                        systemPrompt,
                        model: selection.model,
                        thinkingLevel: selection.thinkingLevel,
                        tools,
                    },
                    convertToLlm,
                    ...agentStreamOptions(streamFn),
                    getApiKey: (providerName) => providerName === selection.model.provider ? auth.apiKey : undefined,
                    beforeToolCall: async ({ toolCall }) => toolCall.name === tool.name ? undefined : { block: true, reason: `Permission arbiter tool '${toolCall.name}' is not allowed.` },
                    toolExecution: "sequential",
                });
                await agent.prompt(`Tool: ${request.toolName}\nRedacted arguments: ${preview}`);
                if (!decision)
                    return finish(false, "Watchdog permission arbiter returned no decision.", "malformed");
                const approved = decision.decision === "approve";
                return finish(approved, decision.reason, decision.decision);
            };
            return await Promise.race([
                run(),
                new Promise((resolve) => { timeout = setTimeout(() => { agent?.abort(); resolve(finish(false, "Watchdog permission decision timed out.", "timeout")); }, childConfig.agentEndTimeoutMs); }),
                new Promise((resolve) => {
                    abort = () => { agent?.abort(); resolve(finish(false, "Watchdog permission decision was cancelled.", "cancelled")); };
                    request.signal?.addEventListener("abort", abort, { once: true });
                    request.ctx.signal?.addEventListener("abort", abort, { once: true });
                }),
            ]);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return finish(false, `Watchdog permission arbiter failed closed: ${reason}`, reason.includes("timed out") ? "timeout" : "error");
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (abort) {
                request.signal?.removeEventListener("abort", abort);
                request.ctx.signal?.removeEventListener("abort", abort);
            }
        }
    };
}
export const requestWatchdogPermission = createWatchdogPermissionArbiter();
//# sourceMappingURL=permission-arbiter.js.map