import { sanitizeDisplayText, truncateDisplayText } from "../../shared/display-text.js";
import { formatModelThinking } from "../../shared/formatters.js";
import { childThinkingLevel } from "../../shared/model-info.js";
import { HOST_STEP_MAX_COUNT, HOST_STEP_MAX_DETAIL_CHARS, HOST_STEP_MAX_LABEL_CHARS, HOST_STEP_MAX_PROVIDER_CHARS, HOST_STEP_MAX_REASON_CHARS, HOST_STEP_MAX_REF_CHARS, HOST_STEP_MAX_ROLE_CHARS, HOST_STEP_MAX_TARGET_CHARS, hostStepReportName, parseHostStepNode, validHostStepNodes } from "./host-step-status.js";
import { workflowPreflightLaneForRuntimeKey } from "../../workflows/workflow-preflight.js";
import { workflowGraphStageNodes } from "./workflow-graph.js";
export const ASYNC_STATUS_SNAPSHOT_KIND = "pi-subagents.async-status-snapshot";
export const ASYNC_STATUS_SNAPSHOT_VERSION = 1;
const DEFAULT_MAX_RUNS = 20;
const DEFAULT_MAX_CHILDREN_PER_NODE = 8;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_STRING_LENGTH = 160;
const DEFAULT_MAX_SERIALIZED_BYTES = 32 * 1024;
const ASYNC_STATUS_SNAPSHOT_STATES = {
    queued: true,
    running: true,
    complete: true,
    failed: true,
    partial: true,
    paused: true,
    stopped: true,
    rejected: true,
};
function isAsyncStatusSnapshotState(value) {
    return Object.hasOwn(ASYNC_STATUS_SNAPSHOT_STATES, value);
}
function validHostStepList(source) {
    if (source && "nodes" in source)
        return validHostStepNodes(source);
    const hostSteps = [];
    for (const [index, value] of (source ?? []).slice(0, HOST_STEP_MAX_COUNT).entries()) {
        try {
            hostSteps.push(parseHostStepNode(value, `hostSteps[${index}]`));
        }
        catch {
            // Renderers must not turn malformed host data into a fake child row.
        }
    }
    return hostSteps;
}
function resolveCaps(options) {
    return {
        maxRuns: Math.max(0, Math.floor(options.maxRuns ?? DEFAULT_MAX_RUNS)),
        maxChildrenPerNode: Math.max(0, Math.floor(options.maxChildrenPerNode ?? DEFAULT_MAX_CHILDREN_PER_NODE)),
        maxDepth: Math.max(0, Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH)),
        maxStringLength: Math.max(0, Math.floor(options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH)),
        maxSerializedBytes: Math.max(256, Math.floor(options.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES)),
    };
}
function publicText(value, fallback, maxLength) {
    if (typeof value !== "string")
        return fallback;
    const normalized = sanitizeDisplayText(value.slice(0, Math.max(0, maxLength * 4)));
    return truncateDisplayText(normalized || fallback, maxLength);
}
function publicOptionalText(value, maxLength) {
    if (typeof value !== "string")
        return undefined;
    const normalized = sanitizeDisplayText(value.slice(0, Math.max(0, maxLength * 4)));
    return normalized ? truncateDisplayText(normalized, maxLength) : undefined;
}
function publicTime(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function publicCount(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function normalizeState(value) {
    if (value === "completed")
        return "complete";
    if (value === "pending")
        return "queued";
    if (isAsyncStatusSnapshotState(value))
        return value;
    return "partial";
}
function terminalState(state) {
    return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}
function kindForMode(mode) {
    return mode === "workflow" ? "workflow" : "subagent";
}
function labelForAgents(agents, fallback, maxLength) {
    if (!agents?.length)
        return publicText(fallback, fallback, maxLength);
    const visible = agents.slice(0, 3).map((agent) => publicText(agent, "agent", maxLength)).join(", ");
    const suffix = agents.length > 3 ? `, +${agents.length - 3} more` : "";
    return truncateDisplayText(`${visible}${suffix}`, maxLength);
}
function activityFor(source, ctx) {
    const currentTool = publicOptionalText(source.currentTool, ctx.caps.maxStringLength);
    const lastActivityAt = publicTime(source.lastActivityAt);
    const currentToolStartedAt = publicTime(source.currentToolStartedAt);
    const turnCount = publicCount(source.turnCount);
    const toolCount = publicCount(source.toolCount);
    const activity = {
        ...(typeof source.activityState === "string" ? { state: publicText(source.activityState, "unknown", ctx.caps.maxStringLength) } : {}),
        ...(currentTool ? { currentTool } : {}),
        ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
        ...(currentToolStartedAt !== undefined ? { currentToolStartedAt } : {}),
        ...(turnCount !== undefined ? { turnCount } : {}),
        ...(toolCount !== undefined ? { toolCount } : {}),
    };
    return Object.keys(activity).length ? activity : undefined;
}
function appendBoundedChildren(children, source, ctx) {
    const remaining = Math.max(0, ctx.caps.maxChildrenPerNode - children.length);
    children.push(...source.slice(0, remaining));
    ctx.omitted.children += Math.max(0, source.length - remaining);
}
function stepIdentity(step, index, ctx) {
    return {
        id: publicText("workflowKey" in step && step.workflowKey ? step.workflowKey : "runId" in step && step.runId ? step.runId : `step:${index}`, `step:${index}`, ctx.caps.maxStringLength),
        label: publicText("label" in step && step.label ? step.label : step.agent, "step", ctx.caps.maxStringLength),
    };
}
function projectStep(step, index, depth, ctx) {
    const state = normalizeState(step.status);
    const startedAt = publicTime(step.startedAt);
    const durationMs = "durationMs" in step ? publicTime(step.durationMs) : undefined;
    const endedAt = publicTime(step.endedAt) ?? (terminalState(state) && startedAt !== undefined && durationMs !== undefined ? publicTime(startedAt + durationMs) : undefined);
    const updatedAt = endedAt ?? publicTime(step.lastActivityAt) ?? startedAt;
    const activity = activityFor(step, ctx);
    const { id, label } = stepIdentity(step, index, ctx);
    const node = {
        id,
        kind: "step",
        label,
        state,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(terminalState(state) && endedAt !== undefined ? { endedAt } : {}),
        ...(activity ? { activity } : {}),
    };
    if (depth < ctx.caps.maxDepth && step.children?.length) {
        const nested = step.children.map((child, childIndex) => projectNestedRun(child, childIndex, depth + 1, ctx));
        const bounded = [];
        appendBoundedChildren(bounded, nested, ctx);
        if (bounded.length)
            node.children = bounded;
    }
    else if (step.children?.length) {
        ctx.omitted.children += step.children.length;
    }
    return node;
}
function projectNestedRun(child, index, depth, ctx) {
    const state = normalizeState(child.state);
    const startedAt = publicTime(child.startedAt);
    const endedAt = publicTime(child.endedAt);
    const updatedAt = publicTime(child.lastUpdate) ?? endedAt ?? publicTime(child.lastActivityAt) ?? startedAt;
    const activity = activityFor(child, ctx);
    const node = {
        id: publicText(child.id, `nested:${index}`, ctx.caps.maxStringLength),
        kind: kindForMode(child.mode),
        label: child.agent ? publicText(child.agent, "subagent", ctx.caps.maxStringLength) : labelForAgents(child.agents, child.mode ?? "subagent", ctx.caps.maxStringLength),
        state,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(terminalState(state) && endedAt !== undefined ? { endedAt } : {}),
        ...(activity ? { activity } : {}),
    };
    if (depth < ctx.caps.maxDepth) {
        const nestedSteps = child.steps?.map((step, stepIndex) => projectStep(step, stepIndex, depth + 1, ctx)) ?? [];
        const nestedChildren = child.children?.map((nested, childIndex) => projectNestedRun(nested, childIndex, depth + 1, ctx)) ?? [];
        const bounded = [];
        appendBoundedChildren(bounded, [...nestedSteps, ...nestedChildren], ctx);
        if (bounded.length)
            node.children = bounded;
    }
    else {
        ctx.omitted.children += (child.steps?.length ?? 0) + (child.children?.length ?? 0);
    }
    return node;
}
function hostStepSnapshotState(state, verdict) {
    if (state === "pending")
        return "queued";
    if (state === "running")
        return "running";
    if (state === "cancelled")
        return "stopped";
    if (state === "error" || verdict === "fail")
        return "failed";
    return verdict === undefined || verdict === "inconclusive" ? "partial" : "complete";
}
function projectHostStep(hostStep, ctx) {
    const state = hostStepSnapshotState(hostStep.state, hostStep.verdict);
    const detail = publicOptionalText(hostStep.detail, ctx.caps.maxStringLength);
    const report = publicOptionalText(hostStepReportName(hostStep.reportPath), ctx.caps.maxStringLength);
    const hostMetadata = {
        kind: hostStep.monitorKind,
        state: hostStep.state,
        ...(hostStep.provider ? { provider: publicText(hostStep.provider, "provider", ctx.caps.maxStringLength) } : {}),
        ...(hostStep.role ? { role: publicText(hostStep.role, "role", ctx.caps.maxStringLength) } : {}),
        ...(hostStep.verdict ? { verdict: hostStep.verdict } : {}),
        ...(hostStep.reasonCode ? { reasonCode: publicText(hostStep.reasonCode, "reason", ctx.caps.maxStringLength) } : {}),
        ...(detail ? { detail } : {}),
        ...(hostStep.target ? { target: publicText(hostStep.target, "target", ctx.caps.maxStringLength) } : {}),
        ...(hostStep.freshness?.stale !== undefined ? { stale: hostStep.freshness.stale } : {}),
        ...(report ? { report } : {}),
    };
    return {
        id: publicText(hostStep.id, "host-step", ctx.caps.maxStringLength),
        kind: "host-step",
        label: publicText(hostStep.label, "host step", ctx.caps.maxStringLength),
        state,
        updatedAt: hostStep.updatedAt,
        ...(terminalState(state) ? { endedAt: hostStep.updatedAt } : {}),
        hostStep: hostMetadata,
    };
}
function asyncJobOrder(left, right) {
    const leftRank = left.status === "running" ? 0 : left.status === "queued" ? 1 : 2;
    const rightRank = right.status === "running" ? 0 : right.status === "queued" ? 1 : 2;
    const leftTime = left.updatedAt ?? left.startedAt ?? 0;
    const rightTime = right.updatedAt ?? right.startedAt ?? 0;
    return leftRank - rightRank || rightTime - leftTime || left.asyncId.localeCompare(right.asyncId);
}
function hasCyclicWorkflowParent(job, parents) {
    const seen = new Set([job.asyncId]);
    let parentId = job.parentWorkflowRunId;
    while (parentId) {
        if (seen.has(parentId))
            return true;
        seen.add(parentId);
        parentId = parents.get(parentId)?.parentWorkflowRunId;
    }
    return false;
}
function groupMaterializedChildren(jobs) {
    const parents = new Map(jobs.filter((job) => job.mode === "workflow").map((job) => [job.asyncId, job]));
    const childrenByParent = new Map();
    const liveRoots = new Set();
    const roots = [];
    for (const job of jobs) {
        const parent = job.parentWorkflowRunId ? parents.get(job.parentWorkflowRunId) : undefined;
        const keepLiveRoot = (job.status === "running" || job.status === "queued") && parent?.status !== "running";
        if (parent && !hasCyclicWorkflowParent(job, parents)) {
            const siblings = childrenByParent.get(parent.asyncId) ?? [];
            siblings.push(job);
            childrenByParent.set(parent.asyncId, siblings);
            if (keepLiveRoot) {
                liveRoots.add(job);
                roots.push(job);
            }
        }
        else {
            roots.push(job);
        }
    }
    for (const children of childrenByParent.values())
        children.sort(asyncJobOrder);
    return { roots, childrenByParent, liveRoots };
}
function assignMaterializedChildren(steps, children) {
    const assigned = new Map();
    const claimed = new Set();
    for (const step of steps) {
        if (!step.runId)
            continue;
        const child = children.find((candidate) => !claimed.has(candidate) && candidate.asyncId === step.runId);
        if (child) {
            assigned.set(step, child);
            claimed.add(child);
        }
    }
    for (const step of steps) {
        if (assigned.has(step) || !step.workflowKey)
            continue;
        const child = children.find((candidate) => !claimed.has(candidate) && candidate.workflowKey === step.workflowKey);
        if (child) {
            assigned.set(step, child);
            claimed.add(child);
        }
    }
    return assigned;
}
function projectMaterializedStep(step, index, child, depth, ctx, childrenByParent, liveRoots) {
    const { id, label } = stepIdentity(step, index, ctx);
    const selfStep = child.mode === undefined || child.mode === "single" ? child.steps?.[0] : undefined;
    const live = projectRun(child, ctx, depth, childrenByParent, liveRoots, selfStep !== undefined);
    const laneActivity = activityFor(step, ctx);
    const selfActivity = selfStep ? activityFor(selfStep, ctx) : undefined;
    const activity = laneActivity || selfActivity || live.activity ? { ...laneActivity, ...selfActivity, ...live.activity } : undefined;
    const node = { ...live, id, kind: "step", label };
    if (activity)
        node.activity = activity;
    return node;
}
function projectRun(job, ctx, depth, childrenByParent, liveRoots, omitSteps = false) {
    const state = normalizeState(job.status);
    const startedAt = publicTime(job.startedAt);
    const updatedAt = publicTime(job.updatedAt) ?? startedAt;
    const activity = activityFor(job, ctx);
    const node = {
        id: publicText(job.asyncId, "async", ctx.caps.maxStringLength),
        kind: kindForMode(job.mode),
        label: labelForAgents(job.agents, job.mode ?? "subagent", ctx.caps.maxStringLength),
        state,
        ...(startedAt !== undefined ? { startedAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
        ...(terminalState(state) && updatedAt !== undefined ? { endedAt: updatedAt } : {}),
        ...(activity ? { activity } : {}),
    };
    const steps = omitSteps ? [] : job.steps ?? [];
    const materialized = childrenByParent.get(job.asyncId) ?? [];
    const nestedSummaries = (job.nestedChildren ?? []).filter((child) => !materialized.some((live) => live.asyncId === child.id));
    const loadedKeys = new Set(steps.flatMap((step) => step.workflowKey ? [step.workflowKey] : []));
    const graphStages = job.mode === "workflow" ? workflowGraphStageNodes(job.workflowGraph).filter((graphNode) => !loadedKeys.has(graphNode.id)) : [];
    const graphSteps = graphStages.map((node, index) => ({
        step: { agent: node.agent ?? node.label, status: workflowGraphStepStatus(node.status), workflowKey: node.id, label: node.label },
        index: node.flatIndex ?? index,
    }));
    const lanes = [...steps, ...graphSteps.map(({ step }) => step)];
    const assigned = assignMaterializedChildren(lanes, materialized);
    const claimed = new Set(assigned.values());
    if (depth < ctx.caps.maxDepth) {
        const childDepth = depth + 1;
        const projectLane = (step, index) => {
            const child = assigned.get(step);
            if (!child)
                return projectStep(step, index, childDepth, ctx);
            if (liveRoots.has(child))
                return undefined;
            return projectMaterializedStep(step, index, child, childDepth, ctx, childrenByParent, liveRoots);
        };
        const stepChildren = steps.map((step, index) => projectLane(step, step.index ?? index)).filter((child) => child !== undefined);
        const graphChildren = graphSteps.map(({ step, index }) => projectLane(step, index)).filter((child) => child !== undefined);
        const nestedChildren = nestedSummaries.map((child, index) => projectNestedRun(child, index, childDepth, ctx));
        const unclaimedChildren = materialized.filter((child) => !claimed.has(child) && !liveRoots.has(child)).map((child) => projectRun(child, ctx, childDepth, childrenByParent, liveRoots));
        const hostStepChildren = validHostStepList(job.hostSteps).map((hostStep) => projectHostStep(hostStep, ctx));
        const ordinaryChildren = [...stepChildren, ...graphChildren, ...nestedChildren, ...unclaimedChildren];
        const retainedHostSteps = hostStepChildren.slice(0, ctx.caps.maxChildrenPerNode);
        const retainedOrdinaryChildren = ordinaryChildren.slice(0, ctx.caps.maxChildrenPerNode - retainedHostSteps.length);
        const bounded = [];
        bounded.push(...retainedOrdinaryChildren, ...retainedHostSteps);
        ctx.omitted.children += ordinaryChildren.length - retainedOrdinaryChildren.length + hostStepChildren.length - retainedHostSteps.length;
        if (bounded.length)
            node.children = bounded;
    }
    else {
        const rootAssignments = [...assigned.values()].filter((child) => liveRoots.has(child)).length;
        const unclaimedChildren = materialized.filter((child) => !claimed.has(child) && !liveRoots.has(child)).length;
        ctx.omitted.children += lanes.length - rootAssignments + nestedSummaries.length + unclaimedChildren + validHostStepList(job.hostSteps).length;
    }
    return node;
}
function snapshotBytes(snapshot) {
    return Buffer.byteLength(JSON.stringify(snapshot), "utf8");
}
function enforceByteLimit(snapshot) {
    if (snapshotBytes(snapshot) <= snapshot.caps.maxSerializedBytes)
        return;
    snapshot.omitted.byteLimitExceeded = true;
    const runs = snapshot.runs;
    const initialOmittedRuns = snapshot.omitted.runs;
    let lower = 0;
    let upper = Math.max(0, runs.length - 1);
    while (lower < upper) {
        const retained = Math.ceil((lower + upper) / 2);
        snapshot.runs = runs.slice(0, retained);
        snapshot.omitted.runs = initialOmittedRuns + runs.length - retained;
        if (snapshotBytes(snapshot) <= snapshot.caps.maxSerializedBytes)
            lower = retained;
        else
            upper = retained - 1;
    }
    snapshot.runs = runs.slice(0, lower);
    snapshot.omitted.runs = initialOmittedRuns + runs.length - lower;
}
function workflowStepActivity(step) {
    if (step.currentTool)
        return `tool ${step.currentTool}`;
    if (step.currentPath)
        return step.currentPath.split(/[\\/]/).at(-1);
    if (step.activityState === "needs_attention")
        return "needs attention";
    if (step.activityState === "active_long_running")
        return "long-running";
    if (step.turnCount !== undefined)
        return `${step.turnCount} turns`;
    if (step.toolCount !== undefined)
        return `${step.toolCount} tools`;
    return undefined;
}
function workflowStepName(step, index) {
    const key = step.workflowKey ?? `step ${index + 1}`;
    const label = step.label && step.label !== key ? ` · ${step.label}` : "";
    const phase = step.phase ? `${step.phase}: ` : "";
    return `${phase}${key}${label} (${step.agent})`;
}
function hostStepRow(hostStep) {
    const freshness = hostStep.freshness
        ? {
            expectedRef: publicText(hostStep.freshness.expectedRef, "ref", HOST_STEP_MAX_REF_CHARS),
            ...(hostStep.freshness.observedRef ? { observedRef: publicText(hostStep.freshness.observedRef, "ref", HOST_STEP_MAX_REF_CHARS) } : {}),
            ...(hostStep.freshness.stale !== undefined ? { stale: hostStep.freshness.stale } : {}),
        }
        : undefined;
    return {
        name: publicText(hostStep.label, "host step", HOST_STEP_MAX_LABEL_CHARS),
        kind: hostStep.monitorKind,
        state: hostStep.state,
        ...(hostStep.role ? { role: publicText(hostStep.role, "role", HOST_STEP_MAX_ROLE_CHARS) } : {}),
        ...(hostStep.provider ? { provider: publicText(hostStep.provider, "provider", HOST_STEP_MAX_PROVIDER_CHARS) } : {}),
        ...(hostStep.verdict ? { verdict: hostStep.verdict } : {}),
        ...(hostStep.reasonCode ? { reasonCode: publicText(hostStep.reasonCode, "reason", HOST_STEP_MAX_REASON_CHARS) } : {}),
        ...(hostStep.detail ? { detail: publicText(hostStep.detail, "detail", HOST_STEP_MAX_DETAIL_CHARS) } : {}),
        ...(hostStep.target ? { target: publicText(hostStep.target, "target", HOST_STEP_MAX_TARGET_CHARS) } : {}),
        ...(freshness ? { freshness } : {}),
        ...(hostStep.reportPath ? { reportPath: hostStepReportName(hostStep.reportPath) } : {}),
    };
}
function isWorkflowPreflight(value) {
    return value !== undefined && !Array.isArray(value) && "lanes" in value;
}
function isWorkflowGraph(value) {
    return value !== undefined && !Array.isArray(value) && "nodes" in value;
}
function workflowGraphRowState(status) {
    switch (status) {
        case "pending":
            return "planned";
        case "completed":
            return "complete";
        case "detached":
            return "paused";
        default:
            return status;
    }
}
function workflowGraphStepStatus(status) {
    switch (status) {
        case "completed":
            return "complete";
        case "detached":
            return "paused";
        default:
            return status;
    }
}
function workflowGraphRowName(node) {
    const key = publicText(node.id, "stage", HOST_STEP_MAX_LABEL_CHARS);
    const label = publicOptionalText(node.label, HOST_STEP_MAX_LABEL_CHARS);
    const phase = publicOptionalText(node.phase, HOST_STEP_MAX_LABEL_CHARS);
    const agent = publicOptionalText(node.agent, HOST_STEP_MAX_LABEL_CHARS);
    return `${phase ? `${phase}: ` : ""}${key}${label && label !== node.id ? ` · ${label}` : ""}${agent ? ` (${agent})` : ""}`;
}
function projectWorkflowGraphRow(node, preflight) {
    return {
        name: workflowGraphRowName(node),
        state: workflowGraphRowState(node.status),
        ...(preflight ? { preflight } : {}),
    };
}
/** Project authoritative workflow facts into compact rows, annotated by preflight hints. */
export function projectAsyncWorkflowRows(steps, hostStepsOrPreflight, preflightOverride) {
    const preflight = preflightOverride ?? (isWorkflowPreflight(hostStepsOrPreflight) ? hostStepsOrPreflight : undefined);
    const graph = isWorkflowGraph(hostStepsOrPreflight) ? hostStepsOrPreflight : undefined;
    const hostSteps = isWorkflowPreflight(hostStepsOrPreflight) || graph ? undefined : hostStepsOrPreflight;
    const loaded = steps ?? [];
    const preflightForKey = (key, groupKeys = []) => workflowPreflightLaneForRuntimeKey(preflight, key, groupKeys);
    if (graph) {
        const loadedIndexesByKey = new Map();
        for (const [index, step] of loaded.entries()) {
            if (!step.workflowKey)
                continue;
            const indexes = loadedIndexesByKey.get(step.workflowKey) ?? [];
            indexes.push(index);
            loadedIndexesByKey.set(step.workflowKey, indexes);
        }
        const consumed = new Set();
        const childRows = [];
        const graphStages = workflowGraphStageNodes(graph);
        const graphKeys = new Set(graphStages.map((node) => node.id));
        const graphPhaseByNodeId = new Map();
        for (const phase of graph.phases) {
            for (const nodeId of phase.nodeIds) {
                if (graphKeys.has(nodeId) && !graphPhaseByNodeId.has(nodeId))
                    graphPhaseByNodeId.set(nodeId, phase.title);
            }
        }
        for (const node of graphStages) {
            const lane = preflightForKey(node.id, [node.phase, graphPhaseByNodeId.get(node.id)]);
            const indexes = (loadedIndexesByKey.get(node.id) ?? []).filter((index) => !consumed.has(index));
            if (indexes.length > 0) {
                for (const index of indexes) {
                    consumed.add(index);
                    childRows.push(projectLoadedWorkflowRow(loaded[index], index, lane));
                }
            }
            else {
                childRows.push(projectWorkflowGraphRow(node, lane));
            }
        }
        for (const [index, step] of loaded.entries()) {
            if (!consumed.has(index))
                childRows.push(projectLoadedWorkflowRow(step, index, step.workflowKey ? preflightForKey(step.workflowKey, [step.phase]) : undefined));
        }
        return [...childRows, ...validHostStepList(graph).map(hostStepRow)];
    }
    return [
        ...loaded.map((step, index) => projectLoadedWorkflowRow(step, index, step.workflowKey ? preflightForKey(step.workflowKey, [step.phase]) : undefined)),
        ...validHostStepList(hostSteps).map(hostStepRow),
    ];
}
function projectLoadedWorkflowRow(step, index, preflight) {
    const modelThinking = formatModelThinking(step.model, step.thinking) || undefined;
    const thinking = childThinkingLevel(step);
    const activity = workflowStepActivity(step);
    return {
        name: workflowStepName(step, index),
        state: step.status,
        ...(step.context ? { context: step.context } : {}),
        ...(modelThinking ? { modelThinking } : {}),
        ...(thinking ? { thinking } : {}),
        ...(activity ? { activity } : {}),
        ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
        ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
        ...(step.tokens?.total !== undefined ? { tokens: step.tokens.total } : {}),
        ...(step.tokens?.window !== undefined ? { window: step.tokens.window } : {}),
        ...(preflight ? { preflight } : {}),
    };
}
/** Project already-loaded async status facts into the bounded public snapshot shape. */
export function projectAsyncStatusSnapshot(jobs, options = {}) {
    const caps = resolveCaps(options);
    const ctx = { caps, omitted: { runs: 0, children: 0, byteLimitExceeded: false } };
    const { roots, childrenByParent, liveRoots } = groupMaterializedChildren([...jobs]);
    const sorted = roots.sort(asyncJobOrder);
    ctx.omitted.runs += Math.max(0, sorted.length - caps.maxRuns);
    const snapshot = {
        kind: ASYNC_STATUS_SNAPSHOT_KIND,
        version: ASYNC_STATUS_SNAPSHOT_VERSION,
        generatedAt: options.generatedAt ?? Date.now(),
        caps,
        omitted: ctx.omitted,
        runs: sorted.slice(0, caps.maxRuns).map((job) => projectRun(job, ctx, 0, childrenByParent, liveRoots)),
    };
    enforceByteLimit(snapshot);
    return snapshot;
}
//# sourceMappingURL=async-status-projection.js.map