import { previewSimpleWorkflowRun } from "../workflows/scripted-workflow.js";
import { deriveChildSessionName } from "../shared/child-session-name.js";
import { SLASH_RESULT_TYPE } from "../shared/types.js";
const liveSnapshots = new Map();
const finalSnapshots = new Map();
let versionCounter = 1;
const EMPTY_MESSAGES = [];
const EMPTY_USAGE = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
};
function nextVersion() {
    return versionCounter++;
}
function cloneUsage() {
    return { ...EMPTY_USAGE };
}
function createPlaceholderResult(agent, task, status, index) {
    const sessionName = deriveChildSessionName({ agent, task });
    return {
        agent,
        task,
        ...(sessionName ? { sessionName } : {}),
        index,
        exitCode: 0,
        messages: EMPTY_MESSAGES,
        usage: cloneUsage(),
        progress: {
            index,
            agent,
            ...(sessionName ? { sessionName } : {}),
            status,
            task,
            recentTools: [],
            recentOutput: [],
            toolCount: 0,
            tokens: 0,
            durationMs: 0,
        },
    };
}
function buildParallelInitialResult(params) {
    const tasks = params.tasks ?? [];
    return {
        content: [{ type: "text", text: tasks.map((task) => `${task.agent}: ${task.task}`).join("\n\n") }],
        details: {
            mode: "parallel",
            ...(params.async ? { background: true } : {}),
            ...(params.context === "fresh" || params.context === "fork" ? { context: params.context } : {}),
            results: tasks.map((task, index) => createPlaceholderResult(task.agent, task.task, "running", index)),
            progress: tasks.map((task, index) => {
                const sessionName = deriveChildSessionName({ agent: task.agent, task: task.task });
                return {
                    index,
                    agent: task.agent,
                    ...(sessionName ? { sessionName } : {}),
                    status: "running",
                    task: task.task,
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 0,
                    tokens: 0,
                    durationMs: 0,
                };
            }),
        },
    };
}
function isParallelChainStep(step) {
    return "parallel" in step && Array.isArray(step.parallel);
}
function chainStepLabel(step) {
    if (isParallelChainStep(step)) {
        return `[${step.parallel.map((entry) => entry.agent).join("+")}]`;
    }
    return step.agent;
}
function flattenChainResults(chain, fallbackTask) {
    const results = [];
    let flatIndex = 0;
    for (const step of chain) {
        if (isParallelChainStep(step)) {
            for (const task of step.parallel) {
                results.push(createPlaceholderResult(task.agent, task.task ?? fallbackTask ?? "", results.length === 0 ? "running" : "pending", flatIndex));
                flatIndex++;
            }
            continue;
        }
        results.push(createPlaceholderResult(step.agent, step.task ?? fallbackTask ?? "", results.length === 0 ? "running" : "pending", flatIndex));
        flatIndex++;
    }
    return results;
}
function buildChainInitialResult(params) {
    const chain = (params.chain ?? []);
    const results = flattenChainResults(chain, params.task);
    return {
        content: [{
                type: "text",
                text: results.map((result, index) => `Step ${index + 1}: ${result.agent}\n${result.task}`).join("\n\n"),
            }],
        details: {
            mode: "chain",
            ...(params.async ? { background: true } : {}),
            ...(params.context === "fresh" || params.context === "fork" ? { context: params.context } : {}),
            results,
            progress: results.map((result, index) => ({
                index,
                agent: result.agent,
                ...(result.sessionName ? { sessionName: result.sessionName } : {}),
                status: index === 0 ? "running" : "pending",
                task: result.task,
                recentTools: [],
                recentOutput: [],
                toolCount: 0,
                tokens: 0,
                durationMs: 0,
            })),
            chainAgents: chain.map((step) => chainStepLabel(step)),
            totalSteps: chain.length,
            currentStepIndex: 0,
        },
    };
}
function buildSingleInitialResult(params) {
    const preview = previewSimpleWorkflowRun(params.workflowScript) ?? {};
    const agent = params.agent ?? preview.agent ?? "subagent";
    const task = params.task ?? preview.task ?? "";
    const sessionName = deriveChildSessionName({ agent, task });
    return {
        content: [{ type: "text", text: task }],
        details: {
            mode: "single",
            ...(params.async ? { background: true } : {}),
            ...(params.context === "fresh" || params.context === "fork" ? { context: params.context } : {}),
            results: [createPlaceholderResult(agent, task, "running", 0)],
            progress: [{
                    index: 0,
                    agent,
                    ...(sessionName ? { sessionName } : {}),
                    status: "running",
                    task,
                    recentTools: [],
                    recentOutput: [],
                    toolCount: 0,
                    tokens: 0,
                    durationMs: 0,
                }],
        },
    };
}
export function buildSlashInitialResult(requestId, params) {
    const result = (params.tasks?.length ?? 0) > 0
        ? buildParallelInitialResult(params)
        : (params.chain?.length ?? 0) > 0
            ? buildChainInitialResult(params)
            : buildSingleInitialResult(params);
    liveSnapshots.set(requestId, { result, version: nextVersion() });
    finalSnapshots.delete(requestId);
    return { requestId, result };
}
function cloneResultsWithProgress(results, progress) {
    return results.map((result, index) => {
        const nextProgress = progress?.find((entry) => entry.index === index
            || (entry.index === undefined && entry.agent === result.agent))
            ?? result.progress;
        return nextProgress ? { ...result, progress: nextProgress } : result;
    });
}
export function applySlashUpdate(requestId, update) {
    const snapshot = liveSnapshots.get(requestId);
    if (!snapshot)
        return;
    const progress = update.progress;
    if (!progress || !snapshot.result.details)
        return;
    const currentStepIndex = progress.findIndex((entry) => entry.status === "running");
    const nextDetails = {
        ...snapshot.result.details,
        progress,
        results: cloneResultsWithProgress(snapshot.result.details.results, progress),
        ...(snapshot.result.details.mode === "chain" && currentStepIndex >= 0 ? { currentStepIndex } : {}),
    };
    liveSnapshots.set(requestId, {
        result: {
            ...snapshot.result,
            details: nextDetails,
        },
        version: nextVersion(),
    });
}
export function finalizeSlashResult(response) {
    const snapshot = {
        result: response.result,
        version: nextVersion(),
    };
    finalSnapshots.set(response.requestId, snapshot);
    liveSnapshots.delete(response.requestId);
    return {
        requestId: response.requestId,
        result: response.result,
    };
}
export function failSlashResult(requestId, params, message) {
    const initial = buildSlashInitialResult(requestId, params).result;
    const failedResults = initial.details.results.map((result) => ({
        ...result,
        exitCode: 1,
        error: message,
        progress: result.progress ? { ...result.progress, status: "failed" } : result.progress,
    }));
    const result = {
        content: [{ type: "text", text: message }],
        details: {
            ...initial.details,
            results: failedResults,
            progress: failedResults.map((entry) => entry.progress).filter(Boolean),
        },
    };
    const snapshot = { result, version: nextVersion() };
    finalSnapshots.set(requestId, snapshot);
    liveSnapshots.delete(requestId);
    return { requestId, result };
}
function isSlashMessageDetails(value) {
    if (!value || typeof value !== "object")
        return false;
    const v = value;
    if (typeof v.requestId !== "string" || !v.requestId)
        return false;
    if (!v.result || !Array.isArray(v.result.content))
        return false;
    return !!v.result.details && Array.isArray(v.result.details.results);
}
export function resolveSlashMessageDetails(value) {
    return isSlashMessageDetails(value) ? value : undefined;
}
export function getSlashRenderableSnapshot(details) {
    return finalSnapshots.get(details.requestId)
        ?? liveSnapshots.get(details.requestId)
        ?? { result: details.result, version: 0 };
}
export function restoreSlashFinalSnapshots(entries) {
    liveSnapshots.clear();
    finalSnapshots.clear();
    for (const entry of entries) {
        const e = entry;
        if (e?.type !== "custom_message" || e.customType !== SLASH_RESULT_TYPE)
            continue;
        const details = resolveSlashMessageDetails(e.details);
        if (!details)
            continue;
        finalSnapshots.set(details.requestId, { result: details.result, version: nextVersion() });
    }
}
export function clearSlashSnapshots() {
    liveSnapshots.clear();
    finalSnapshots.clear();
}
//# sourceMappingURL=slash-live-state.js.map