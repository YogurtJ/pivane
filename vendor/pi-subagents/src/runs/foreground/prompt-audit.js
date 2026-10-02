import { agentStreamOptions } from "../../shared/agent-stream-options.js";
import { opencodeSessionHeaders } from "../../shared/opencode-session-headers.js";
const livePrompts = new WeakMap();
function fullModelId(model) {
    return `${model.provider}/${model.id}`;
}
function textContent(value) {
    if (typeof value === "string")
        return value;
    if (!Array.isArray(value))
        return "";
    return value.map((item) => item && typeof item === "object" && item.type === "text" ? String(item.text ?? "") : "").join("");
}
function finalAssistantText(agent) {
    for (let index = agent.state.messages.length - 1; index >= 0; index--) {
        const message = agent.state.messages[index];
        if (message && typeof message === "object" && message.role === "assistant") {
            return textContent(message.content).trim();
        }
    }
    return "";
}
async function resolveRewriteAuth(ctx, model) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (auth.ok === false)
        throw new Error(`Prompt redo model auth failed for ${fullModelId(model)}: ${auth.error}`);
    return {
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        ...(auth.headers ? { headers: auth.headers } : {}),
        ...(auth.env ? { env: auth.env } : {}),
    };
}
export async function rewritePromptWithGuidance(input) {
    const model = input.ctx.model;
    if (!model)
        throw new Error("Prompt redo needs the current session model to rewrite the authored task.");
    const [{ Agent }, { convertToLlm }] = await Promise.all([
        import("@earendil-works/pi-agent-core"),
        import("@earendil-works/pi-coding-agent"),
    ]);
    const auth = await resolveRewriteAuth(input.ctx, model);
    const baseStreamFn = input.streamFn ?? ((nextModel, context, streamOptions) => input.ctx.modelRegistry.streamSimple(nextModel, context, streamOptions));
    const sessionId = input.ctx.sessionManager.getSessionId();
    const streamFn = (nextModel, context, streamOptions) => baseStreamFn(nextModel, context, {
        ...streamOptions,
        ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
        env: auth.env || streamOptions?.env ? { ...(auth.env ?? {}), ...(streamOptions?.env ?? {}) } : undefined,
        headers: { ...opencodeSessionHeaders(nextModel, sessionId), ...(streamOptions?.headers ?? {}), ...(auth.headers ?? {}) },
    });
    const ctxThinking = input.ctx.getThinkingLevel?.();
    const agent = new Agent({
        initialState: {
            systemPrompt: [
                "Rewrite one subagent authored task from Prompt Audit context.",
                "Return only the revised authored task text.",
                "Do not add Markdown fences, explanations, labels, or commentary.",
                "Preserve the original intent unless the guidance explicitly changes it.",
                "Do not include runtime additions unless they are needed as ordinary task context.",
            ].join("\n"),
            model,
            thinkingLevel: ctxThinking ?? "off",
            tools: [],
        },
        convertToLlm,
        ...agentStreamOptions(streamFn),
        getApiKey: (providerName) => providerName === model.provider ? auth.apiKey : undefined,
        toolExecution: "sequential",
    });
    const abort = () => agent.abort();
    input.ctx.signal?.addEventListener("abort", abort, { once: true });
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
        await agent.prompt([
            "Guidance from the human:",
            input.guidance.trim(),
            "",
            "Authored task:",
            input.authoredTask,
            "",
            "Runtime additions for context only:",
            input.runtimeAdditions,
            "",
            "Final effective prompt for context only:",
            input.finalEffectivePrompt,
        ].join("\n"));
    }
    finally {
        input.ctx.signal?.removeEventListener("abort", abort);
        input.signal?.removeEventListener("abort", abort);
    }
    const rewritten = finalAssistantText(agent);
    if (!rewritten)
        throw new Error("Prompt redo rewrite returned an empty prompt.");
    return rewritten;
}
function runtimeAdditions(authoredTask, effectivePrompt) {
    if (!authoredTask)
        return effectivePrompt;
    const authoredIndex = effectivePrompt.indexOf(authoredTask);
    if (authoredIndex < 0)
        return "(runtime additions unavailable)";
    const before = effectivePrompt.slice(0, authoredIndex).trim();
    const after = effectivePrompt.slice(authoredIndex + authoredTask.length).trim();
    return [before, after].filter(Boolean).join("\n\n") || "(none)";
}
export function registerLivePromptAudit(control, index, authoredTask, effectivePrompt, metadata = {}) {
    let prompts = livePrompts.get(control);
    if (!prompts) {
        prompts = new Map();
        livePrompts.set(control, prompts);
    }
    prompts.set(index, {
        authoredTask,
        runtimeAdditions: runtimeAdditions(authoredTask, effectivePrompt),
        finalEffectivePrompt: effectivePrompt,
        ...(metadata.cwd ? { cwd: metadata.cwd } : {}),
        ...(metadata.outputPath ? { outputPath: metadata.outputPath } : {}),
        ...(metadata.rerun ? { rerun: metadata.rerun } : {}),
    });
}
export function updateLiveEffectivePrompt(control, index, effectivePrompt) {
    const prompt = livePrompts.get(control)?.get(index);
    if (!prompt)
        return;
    prompt.finalEffectivePrompt = effectivePrompt;
    prompt.runtimeAdditions = runtimeAdditions(prompt.authoredTask, effectivePrompt);
}
export function getLivePromptAudit(control, index) {
    return livePrompts.get(control)?.get(index);
}
export function removeLivePromptAudit(control, index) {
    const prompts = livePrompts.get(control);
    if (!prompts)
        return;
    prompts.delete(index);
    if (prompts.size === 0)
        livePrompts.delete(control);
}
//# sourceMappingURL=prompt-audit.js.map