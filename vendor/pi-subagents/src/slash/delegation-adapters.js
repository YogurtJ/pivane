import { cloneJsonWithinByteLimit } from "./delegation-json.js";
export function parsePromptTemplateRequest(data) {
    if (!data || typeof data !== "object")
        return undefined;
    const value = data;
    if (value.tasks !== undefined || value.worktree !== undefined)
        return undefined;
    if (typeof value.requestId !== "string" || !value.requestId)
        return undefined;
    if (typeof value.agent !== "string" || !value.agent)
        return undefined;
    if (typeof value.task !== "string" || !value.task)
        return undefined;
    if (typeof value.model !== "string" || !value.model)
        return undefined;
    if (typeof value.cwd !== "string" || !value.cwd)
        return undefined;
    if (value.context !== "fresh" && value.context !== "fork")
        return undefined;
    return {
        requestId: value.requestId,
        agent: value.agent,
        task: value.task,
        context: value.context,
        model: value.model,
        cwd: value.cwd,
    };
}
function firstTextContent(content) {
    if (!Array.isArray(content))
        return undefined;
    for (const part of content) {
        if (!part || typeof part !== "object")
            continue;
        if (part.type !== "text")
            continue;
        const text = part.text;
        if (typeof text === "string" && text.trim())
            return text.trim();
    }
    return undefined;
}
function filterRecentOutput(lines) {
    if (!lines || lines.length === 0)
        return undefined;
    const filtered = lines.filter((line) => typeof line === "string" && line.trim() && line.trim() !== "(running...)");
    if (filtered.length === 0)
        return undefined;
    return filtered;
}
function sanitizeRecentTools(tools) {
    if (!tools || tools.length === 0)
        return undefined;
    const sanitized = tools.flatMap((entry) => {
        if (typeof entry.tool !== "string" || entry.tool.trim().length === 0)
            return [];
        return [{
                tool: entry.tool,
                args: typeof entry.args === "string" ? entry.args : String(entry.args ?? ""),
            }];
    });
    return sanitized.length > 0 ? sanitized : undefined;
}
function resolveProgressModel(update, entry) {
    const results = update.details?.results;
    if (!results || results.length === 0)
        return undefined;
    if (typeof entry.index === "number" && entry.index >= 0) {
        const byIndex = results[entry.index];
        if (typeof byIndex?.model === "string")
            return byIndex.model;
    }
    if (entry.agent) {
        const byAgent = results.find((result) => result.agent === entry.agent && typeof result.model === "string");
        if (byAgent?.model)
            return byAgent.model;
    }
    const firstWithModel = results.find((result) => typeof result.model === "string");
    return firstWithModel?.model;
}
function toolCallNameFromSummary(summary) {
    const text = typeof summary.expandedText === "string" && summary.expandedText.trim().length > 0
        ? summary.expandedText.trim()
        : typeof summary.text === "string"
            ? summary.text.trim()
            : "";
    if (!text)
        return undefined;
    if (text.startsWith("$ "))
        return "bash";
    return text.match(/^[A-Za-z_][\w.-]*/)?.[0];
}
function buildDelegationMessages(result, fallbackText) {
    if (Array.isArray(result.messages) && result.messages.length > 0)
        return result.messages;
    const toolCallParts = (result.toolCalls ?? []).flatMap((summary) => {
        const name = toolCallNameFromSummary(summary);
        return name ? [{ type: "toolCall", name, arguments: { summary: summary.expandedText ?? summary.text ?? "" } }] : [];
    });
    const text = typeof result.finalOutput === "string" && result.finalOutput.trim().length > 0
        ? result.finalOutput.trim()
        : fallbackText;
    const content = [
        ...toolCallParts,
        ...(text ? [{ type: "text", text }] : []),
    ];
    if (content.length === 0)
        return [];
    return [{ role: "assistant", content }];
}
function isFiniteNonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function buildDelegationUpdateUsage(entry) {
    if (!entry)
        return undefined;
    const { inputTokens, outputTokens, cacheRead, cacheWrite, turnCount } = entry;
    if (!isFiniteNonNegative(inputTokens)
        || !isFiniteNonNegative(outputTokens)
        || !isFiniteNonNegative(cacheRead)
        || !isFiniteNonNegative(cacheWrite)
        || !isFiniteNonNegative(turnCount))
        return undefined;
    return { input: inputTokens, output: outputTokens, cacheRead, cacheWrite, turns: turnCount };
}
export function toDelegationUpdate(requestId, update) {
    const progress = update.details?.progress?.[0];
    const taskProgress = update.details?.progress?.map((entry) => {
        const lastOutput = entry.recentOutput?.[entry.recentOutput.length - 1];
        const safeLastOutput = typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)"
            ? lastOutput
            : undefined;
        return {
            index: entry.index,
            agent: entry.agent ?? "delegate",
            status: entry.status,
            currentTool: entry.currentTool,
            currentToolArgs: entry.currentToolArgs,
            recentOutput: safeLastOutput,
            recentOutputLines: filterRecentOutput(entry.recentOutput),
            recentTools: sanitizeRecentTools(entry.recentTools),
            model: resolveProgressModel(update, entry),
            toolCount: entry.toolCount,
            durationMs: entry.durationMs,
            tokens: entry.tokens,
        };
    });
    if (!progress && (!taskProgress || taskProgress.length === 0))
        return undefined;
    const lastOutput = progress?.recentOutput?.[progress.recentOutput.length - 1];
    const safeLastOutput = typeof lastOutput === "string" && lastOutput.trim() && lastOutput !== "(running...)"
        ? lastOutput
        : undefined;
    return {
        requestId,
        ...(update.details?.runId ? { runId: update.details.runId } : {}),
        currentTool: progress?.currentTool,
        currentToolArgs: progress?.currentToolArgs,
        recentOutput: safeLastOutput,
        recentOutputLines: filterRecentOutput(progress?.recentOutput),
        recentTools: sanitizeRecentTools(progress?.recentTools),
        model: progress ? resolveProgressModel(update, progress) : undefined,
        toolCount: progress?.toolCount,
        usage: buildDelegationUpdateUsage(progress),
        durationMs: progress?.durationMs,
        tokens: progress?.tokens,
        taskProgress,
    };
}
export function toSubagentDelegationExecutionParams(request) {
    return {
        agent: request.agent,
        task: request.task,
        context: request.context,
        cwd: request.cwd,
        model: request.model,
        timeoutMs: request.timeoutMs,
        toolBudget: request.toolBudget,
        skill: request.skill,
        ...(request.result.kind === "structured" ? { outputSchema: request.result.schema } : {}),
        acceptance: false,
        artifacts: request.artifacts,
        ...(request.intercomBridge !== undefined ? { intercomBridge: request.intercomBridge } : {}),
        delegatedThinkingOverride: request.thinking,
        delegatedAllowZeroToolBudget: true,
        async: false,
        foregroundOnly: true,
        clarify: false,
    };
}
export function toSubagentDelegationUpdate(request, result) {
    const legacy = toDelegationUpdate(request.requestId, result);
    if (!legacy)
        return undefined;
    return {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        ...(legacy.runId ? { runId: legacy.runId } : {}),
        ...(legacy.currentTool ? { currentTool: legacy.currentTool } : {}),
        ...(legacy.currentToolArgs ? { currentToolArgs: legacy.currentToolArgs } : {}),
        ...(legacy.recentOutput ? { recentOutput: legacy.recentOutput } : {}),
        ...(legacy.recentOutputLines ? { recentOutputLines: legacy.recentOutputLines } : {}),
        ...(legacy.recentTools ? { recentTools: legacy.recentTools } : {}),
        ...(legacy.model ? { model: legacy.model } : {}),
        ...(typeof legacy.toolCount === "number" ? { toolCount: legacy.toolCount } : {}),
        ...(typeof legacy.durationMs === "number" ? { durationMs: legacy.durationMs } : {}),
        ...(typeof legacy.tokens === "number" ? { tokens: legacy.tokens } : {}),
        ...(legacy.usage ? { usage: legacy.usage } : {}),
    };
}
function resolveSubagentDelegationStatus(result, aborted) {
    if (aborted)
        return "cancelled";
    const child = result.details?.results?.[0];
    if (!child)
        return "failed";
    if (result.details?.timedOut || child.timedOut)
        return "timed_out";
    if (child?.structuredOutputFailed)
        return "structured_output_failed";
    if (child?.toolBudgetBlocked)
        return "tool_budget_exhausted";
    if (child?.acceptance?.status === "rejected" && child.acceptance.explicit)
        return "acceptance_failed";
    if (result.details?.stopped || child?.stopped || child?.interrupted)
        return "interrupted";
    if (result.isError || child?.error || (typeof child?.exitCode === "number" && child.exitCode !== 0))
        return "failed";
    return "completed";
}
const MAX_RESULT_BYTES = 1024 * 1024;
export function toSubagentDelegationResponse(request, result, aborted) {
    const child = result.details?.results?.[0];
    const progress = child?.progressSummary ?? result.details?.progress?.[0];
    let status = resolveSubagentDelegationStatus(result, aborted);
    let error = child?.error ?? (status === "failed" ? firstTextContent(result.content) : undefined);
    let projectedResult;
    if (status === "completed") {
        if (request.result.kind === "text") {
            if (typeof child?.finalOutput !== "string") {
                status = "failed";
                error = "Delegated subagent did not capture a text result.";
            }
            else if (Buffer.byteLength(child.finalOutput, "utf8") > MAX_RESULT_BYTES) {
                status = "failed";
                error = "Delegated text result exceeds 1 MiB when UTF-8 encoded.";
            }
            else {
                projectedResult = { kind: "text", text: child.finalOutput };
            }
        }
        else if (child?.structuredOutput === undefined) {
            status = "failed";
            error = "Delegated subagent did not capture the requested structured result.";
        }
        else {
            const inspected = cloneJsonWithinByteLimit(child.structuredOutput, MAX_RESULT_BYTES);
            if (inspected.ok === false) {
                status = "failed";
                error = inspected.reason === "too_large"
                    ? "Delegated structured result exceeds 1 MiB when encoded."
                    : "Delegated structured result is not plain JSON data.";
            }
            else {
                projectedResult = { kind: "structured", value: inspected.value };
            }
        }
    }
    const usage = child?.usage;
    const childLaunchContractDigest = child?.launchContractDigest;
    return {
        requestId: request.requestId,
        ownerRunId: request.ownerRunId,
        nodeId: request.nodeId,
        status,
        ...(error ? { error } : {}),
        ...(result.details?.runId ? { runId: result.details.runId } : {}),
        ...(child?.agent ? { agent: child.agent } : {}),
        ...(child?.model ? { model: child.model } : {}),
        ...(child?.thinking ? { thinking: child.thinking } : {}),
        ...(typeof child?.exitCode === "number" ? { exitCode: child.exitCode } : {}),
        ...(childLaunchContractDigest ? { launchContractDigest: childLaunchContractDigest } : {}),
        ...(projectedResult ? { result: projectedResult } : {}),
        ...(usage ? {
            usage: {
                input: usage.input,
                output: usage.output,
                cacheRead: usage.cacheRead,
                cacheWrite: usage.cacheWrite,
                cost: usage.cost,
                turns: usage.turns,
                toolCalls: progress?.toolCount ?? 0,
                durationMs: progress?.durationMs ?? 0,
            },
        } : {}),
    };
}
export function toPromptTemplateResponse(request, result) {
    const contentText = firstTextContent(result.content);
    const messages = buildDelegationMessages(result.details?.results?.[0] ?? {}, contentText);
    return {
        ...request,
        messages,
        ...(contentText ? { contentText } : {}),
        isError: result.isError === true,
        errorText: result.isError ? contentText : undefined,
    };
}
//# sourceMappingURL=delegation-adapters.js.map