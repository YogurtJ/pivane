import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { appendJsonl } from "../../shared/artifacts.js";
import { PROMPT_REDACTED, readStatus } from "../../shared/utils.js";
import { deriveChildSessionName } from "../../shared/child-session-name.js";
import { isDynamicRunnerGroup, isParallelGroup } from "../shared/parallel-utils.js";
const APPEND_REQUESTS_DIR = "append-requests";
function appendDir(asyncDir) {
    return path.join(asyncDir, APPEND_REQUESTS_DIR);
}
function appendRequestPath(asyncDir, request) {
    return path.join(appendDir(asyncDir), `${request.createdAt}-${request.id}.json`);
}
function listAppendRequestFiles(asyncDir) {
    const dir = appendDir(asyncDir);
    try {
        return fs.readdirSync(dir)
            .filter((entry) => entry.endsWith(".json"))
            .map((entry) => path.join(dir, entry))
            .sort();
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
export function countPendingChainAppendRequests(asyncDir) {
    return listAppendRequestFiles(asyncDir).length;
}
export function runnerStepOutputNames(steps) {
    const names = [];
    for (const step of steps) {
        if (isParallelGroup(step)) {
            names.push(...step.parallel.map((task) => task.outputName).filter((name) => Boolean(name)));
        }
        else if (isDynamicRunnerGroup(step)) {
            if (step.collect.as)
                names.push(step.collect.as);
        }
        else if (step.outputName) {
            names.push(step.outputName);
        }
    }
    return names;
}
export function enqueueChainAppendRequest(input) {
    const status = readStatus(input.asyncDir);
    if (!status)
        throw new Error(`No async run status found for '${input.runId}'.`);
    if (status.runId !== input.runId)
        throw new Error(`Async run id mismatch: expected '${input.runId}', found '${status.runId}'.`);
    if (status.mode !== "chain")
        throw new Error(`Run '${input.runId}' is ${status.mode}; only active chain runs accept appended steps.`);
    if (status.state !== "running")
        throw new Error(`Run '${input.runId}' is ${status.state}; only running chain runs accept appended steps.`);
    const stillInProgress = (status.steps ?? []).some((step) => step.status === "running" || step.status === "pending") || (status.pendingAppends ?? 0) > 0;
    if (!stillInProgress)
        throw new Error(`Run '${input.runId}' has no running or pending chain steps left; append-step must target an in-progress chain.`);
    if (input.steps.length === 0)
        throw new Error("append-step requires one chain step.");
    const request = {
        id: randomUUID(),
        createdAt: input.now ?? Date.now(),
        steps: input.steps,
    };
    fs.mkdirSync(appendDir(input.asyncDir), { recursive: true });
    const persist = () => writeAtomicJson(appendRequestPath(input.asyncDir, request), request);
    if (input.admit)
        input.admit(persist);
    else
        persist();
    let pendingCount = 1;
    const bookkeepingErrors = [];
    try {
        pendingCount = countPendingChainAppendRequests(input.asyncDir);
    }
    catch (error) {
        bookkeepingErrors.push(`pending append count failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const statusPath = path.join(input.asyncDir, "status.json");
    const updatedStatus = { ...status, pendingAppends: pendingCount, lastUpdate: request.createdAt };
    try {
        writeAtomicJson(statusPath, updatedStatus);
    }
    catch (error) {
        bookkeepingErrors.push(`status update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
        appendJsonl(path.join(input.asyncDir, "events.jsonl"), JSON.stringify({
            type: "subagent.chain.append.requested",
            ts: request.createdAt,
            runId: input.runId,
            requestId: request.id,
            stepCount: input.steps.length,
            pendingAppends: pendingCount,
        }));
    }
    catch (error) {
        bookkeepingErrors.push(`event append failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { request, pendingCount, ...(bookkeepingErrors.length > 0 ? { bookkeepingError: bookkeepingErrors.join("; ") } : {}) };
}
function readAppendRequest(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!raw.id || typeof raw.id !== "string")
        return undefined;
    const createdAt = raw.createdAt;
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt))
        return undefined;
    if (!Array.isArray(raw.steps) || raw.steps.length === 0)
        return undefined;
    return { id: raw.id, createdAt, steps: raw.steps };
}
export function readPendingChainAppendRequests(asyncDir) {
    return listAppendRequestFiles(asyncDir)
        .map((filePath) => readAppendRequest(filePath))
        .filter((request) => Boolean(request))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}
export function consumeChainAppendRequests(asyncDir) {
    const requests = [];
    for (const filePath of listAppendRequestFiles(asyncDir)) {
        const request = readAppendRequest(filePath);
        try {
            fs.unlinkSync(filePath);
        }
        catch {
            // The runner should not execute a consumed request twice.
        }
        if (request)
            requests.push(request);
    }
    return requests.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
}
const MAX_STATUS_STEP_DESCRIPTION_CHARS = 160;
/** Bounded one-line per-step task description persisted into status.json for fleet display. */
export function statusStepDescription(task) {
    if (!task?.trim())
        return undefined;
    const description = PROMPT_REDACTED;
    return description.length > MAX_STATUS_STEP_DESCRIPTION_CHARS
        ? `${description.slice(0, MAX_STATUS_STEP_DESCRIPTION_CHARS - 1)}…`
        : description;
}
function statusStepForTask(task) {
    const description = statusStepDescription(task.task);
    const sessionName = task.sessionName ?? deriveChildSessionName({ agent: task.agent, task: task.task, label: task.label });
    return {
        agent: task.agent,
        ...(sessionName ? { sessionName } : {}),
        ...(description ? { description } : {}),
        ...(task.context ? { context: task.context } : {}),
        phase: task.phase,
        label: task.label,
        outputName: task.outputName,
        structured: task.structured,
        status: "pending",
        ...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
        skills: task.skills,
        model: task.model,
        ...(task.contextLimit !== undefined ? { contextLimit: task.contextLimit } : {}),
        thinking: task.thinking,
        requestedModel: task.requestedModel,
        recentTools: [],
        recentOutput: [],
    };
}
function statusStepsForRunnerStep(step) {
    if (isParallelGroup(step))
        return step.parallel.map(statusStepForTask);
    if (isDynamicRunnerGroup(step)) {
        return [{
                agent: `expand:${step.parallel.agent}`,
                ...(step.parallel.context ? { context: step.parallel.context } : {}),
                phase: step.phase ?? step.parallel.phase,
                label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
                outputName: step.collect.as,
                structured: Boolean(step.collect.outputSchema),
                ...(step.parallel.contextLimit !== undefined ? { contextLimit: step.parallel.contextLimit } : {}),
                status: "pending",
                recentTools: [],
                recentOutput: [],
            }];
    }
    return [statusStepForTask(step)];
}
function pushPhase(graph, phase, nodeId) {
    if (!phase)
        return;
    let group = graph.phases.find((candidate) => candidate.title === phase);
    if (!group) {
        group = { title: phase, nodeIds: [] };
        graph.phases.push(group);
    }
    group.nodeIds.push(nodeId);
}
function graphNodeForSequential(step, stepIndex, flatIndex) {
    return {
        id: `step-${stepIndex}`,
        kind: "step",
        agent: step.agent,
        phase: step.phase,
        label: step.label?.trim() || step.agent || `Step ${stepIndex + 1}`,
        status: "pending",
        flatIndex,
        stepIndex,
        outputName: step.outputName,
        structured: step.structured,
    };
}
function graphNodeForParallel(step, stepIndex, flatIndex, graph) {
    const children = step.parallel.map((task, taskIndex) => {
        const childId = `step-${stepIndex}-agent-${taskIndex}`;
        pushPhase(graph, task.phase, childId);
        return {
            id: childId,
            kind: "agent",
            agent: task.agent,
            phase: task.phase,
            label: task.label?.trim() || task.agent || `Agent ${taskIndex + 1}`,
            status: "pending",
            flatIndex: flatIndex + taskIndex,
            stepIndex,
            outputName: task.outputName,
            structured: task.structured,
        };
    });
    return {
        id: `step-${stepIndex}`,
        kind: "parallel-group",
        label: step.parallel.length === 1 ? "Parallel task" : `Parallel group (${step.parallel.length})`,
        status: "pending",
        stepIndex,
        children,
    };
}
function graphNodeForDynamic(step, stepIndex) {
    return {
        id: `step-${stepIndex}`,
        kind: "dynamic-parallel-group",
        label: step.label?.trim() || step.parallel.label?.trim() || `Dynamic fanout (${step.collect.as})`,
        status: "pending",
        stepIndex,
        outputName: step.collect.as,
        structured: Boolean(step.collect.outputSchema),
        dynamic: {
            sourceOutput: step.expand.from.output,
            sourcePath: step.expand.from.path,
            itemName: step.expand.item ?? "item",
            maxItems: step.expand.maxItems,
            collectAs: step.collect.as,
        },
        children: [],
    };
}
function appendWorkflowNode(graph, step, stepIndex, flatIndex) {
    if (!graph)
        return;
    if (isParallelGroup(step)) {
        graph.nodes.push(graphNodeForParallel(step, stepIndex, flatIndex, graph));
        return;
    }
    if (isDynamicRunnerGroup(step)) {
        graph.nodes.push(graphNodeForDynamic(step, stepIndex));
        return;
    }
    const node = graphNodeForSequential(step, stepIndex, flatIndex);
    graph.nodes.push(node);
    pushPhase(graph, step.phase, node.id);
}
export function appendRunnerStepsToStatus(input) {
    let addedChainSteps = 0;
    let addedFlatSteps = 0;
    for (const step of input.steps) {
        const stepIndex = input.status.chainStepCount ?? input.status.steps?.length ?? 0;
        const flatIndex = input.status.steps?.length ?? 0;
        const statusSteps = statusStepsForRunnerStep(step);
        input.status.steps ??= [];
        input.status.steps.push(...statusSteps);
        if (isParallelGroup(step)) {
            input.status.parallelGroups ??= [];
            input.status.parallelGroups.push({ start: flatIndex, count: step.parallel.length, stepIndex });
        }
        else if (isDynamicRunnerGroup(step)) {
            input.status.parallelGroups ??= [];
            input.status.parallelGroups.push({ start: flatIndex, count: 1, stepIndex });
        }
        appendWorkflowNode(input.status.workflowGraph, step, stepIndex, flatIndex);
        input.status.chainStepCount = stepIndex + 1;
        addedChainSteps++;
        addedFlatSteps += statusSteps.length;
    }
    input.status.pendingAppends = input.pendingAppends ?? 0;
    input.status.lastUpdate = input.now ?? Date.now();
    return { addedChainSteps, addedFlatSteps };
}
//# sourceMappingURL=chain-append.js.map