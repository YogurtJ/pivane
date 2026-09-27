import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DIRS, TEMP_ROOT_DIR, } from "../../shared/types.js";
import { isSafeNestedPathId, sanitizeNestedPath } from "./nested-path.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { sanitizeProcessTerminal } from "../background/process-terminal.js";
import { THINKING_LEVELS } from "../../shared/model-info.js";
export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
const ROUTE_FILE = "route.json";
const REGISTRY_FILE = "registry.json";
const ROUTE_INDEX_DIR = ".route-index";
const MAX_EVENT_BYTES = 64 * 1024;
const MAX_STEPS = 12;
const MAX_CHILDREN = 16;
const MAX_DEPTH = 3;
export function isSafeNestedId(value) {
    return isSafeNestedPathId(value);
}
export function assertSafeNestedId(label, value) {
    if (!isSafeNestedId(value))
        throw new Error(`${label} must be a non-empty safe id token.`);
}
function assertSafeId(label, value) {
    assertSafeNestedId(label, value);
}
function containedPath(base, candidate) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}
function commonRouteRoot(route) {
    return path.dirname(path.resolve(route.eventSink));
}
function routeIndexRoot() {
    return path.join(NESTED_EVENTS_DIR, ROUTE_INDEX_DIR, "roots");
}
function routeIndexDir(rootRunId) {
    return path.join(routeIndexRoot(), encodeURIComponent(rootRunId));
}
function routeIndexPath(rootRunId, capabilityToken) {
    return path.join(routeIndexDir(rootRunId), `${encodeURIComponent(capabilityToken)}.json`);
}
function validateRouteShape(route) {
    assertSafeId("rootRunId", route.rootRunId);
    assertSafeId("capabilityToken", route.capabilityToken);
    if (!containedPath(NESTED_EVENTS_DIR, route.eventSink))
        throw new Error("Nested event sink is outside the subagent nested event root.");
    if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox))
        throw new Error("Nested control inbox is outside the subagent nested event root.");
    if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox)))
        throw new Error("Nested event sink and control inbox must share one route root.");
}
export function createNestedRoute(rootRunId) {
    assertSafeId("rootRunId", rootRunId);
    const capabilityToken = randomUUID();
    const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
    const eventSink = path.join(routeRoot, "events");
    const controlInbox = path.join(routeRoot, "controls");
    fs.mkdirSync(eventSink, { recursive: true, mode: 0o700 });
    fs.mkdirSync(controlInbox, { recursive: true, mode: 0o700 });
    const createdAt = Date.now();
    fs.mkdirSync(routeIndexDir(rootRunId), { recursive: true, mode: 0o700 });
    writeAtomicJson(routeIndexPath(rootRunId, capabilityToken), { rootRunId, capabilityToken, routeRoot: path.basename(routeRoot), createdAt });
    writeAtomicJson(path.join(routeRoot, ROUTE_FILE), { rootRunId, capabilityToken, createdAt });
    return { rootRunId, eventSink, controlInbox, capabilityToken };
}
/** Validate a route handed to an in-process child against its on-disk metadata. */
export function resolveNestedRoute(route) {
    const { rootRunId, capabilityToken } = route;
    validateRouteShape(route);
    const routeFile = path.join(commonRouteRoot(route), ROUTE_FILE);
    const metadata = JSON.parse(fs.readFileSync(routeFile, "utf-8"));
    if (metadata.rootRunId !== rootRunId || metadata.capabilityToken !== capabilityToken) {
        throw new Error("Nested event route metadata does not match the provided root id and capability token.");
    }
    return route;
}
export function resolveInheritedNestedRoute(route) {
    try {
        return resolveNestedRoute(route);
    }
    catch (error) {
        console.error("Ignoring invalid nested subagent event route:", error);
        return undefined;
    }
}
/** The nested route an executor inherited from its own child runtime, validated against disk. */
export function inheritedNestedRouteOf(runtime) {
    return runtime?.nestedRoute ? resolveInheritedNestedRoute(runtime.nestedRoute) : undefined;
}
/** The executor's own position in the nested run tree, from its child runtime. */
export function inheritedNestedParentAddressOf(runtime) {
    const parent = runtime?.nestedParent;
    if (!parent || !isSafeNestedId(parent.parentRunId))
        return undefined;
    const depth = Math.min(Math.max(1, clampNumber(parent.depth) ?? 1), MAX_DEPTH);
    return {
        parentRunId: parent.parentRunId,
        ...(parent.parentChildIndex !== undefined ? { parentStepIndex: parent.parentChildIndex } : {}),
        depth,
        path: parent.path.length ? parent.path : [{ runId: parent.parentRunId, ...(parent.parentChildIndex !== undefined ? { stepIndex: parent.parentChildIndex } : {}) }],
    };
}
export function resolveNestedAsyncDir(rootRunId, run) {
    if (!run.asyncDir)
        return undefined;
    const resolved = path.resolve(run.asyncDir);
    const nestedRoot = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
    const relative = path.relative(nestedRoot, resolved);
    return resolved === nestedRoot || (!relative.startsWith("..") && !path.isAbsolute(relative)) ? resolved : undefined;
}
function clampNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function stringValue(value, max = 512) {
    return typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;
}
function sanitizeTokenUsage(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const input = clampNumber(raw.input);
    const output = clampNumber(raw.output);
    const total = clampNumber(raw.total);
    const window = clampNumber(raw.window);
    const windowPeak = clampNumber(raw.windowPeak);
    return input !== undefined && output !== undefined && total !== undefined
        ? { input, output, total, ...(window !== undefined ? { window } : {}), ...(windowPeak !== undefined ? { windowPeak } : {}) }
        : undefined;
}
function sanitizeCost(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const inputTokens = clampNumber(raw.inputTokens);
    const outputTokens = clampNumber(raw.outputTokens);
    const costUsd = clampNumber(raw.costUsd);
    return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined
        ? { inputTokens, outputTokens, costUsd }
        : undefined;
}
function sanitizeLaunchResolvedExtensions(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (raw.version !== 1 || raw.source !== "launch-resolved" || typeof raw.disableAmbientExtensions !== "boolean")
        return undefined;
    const stringList = (input) => Array.isArray(input)
        ? input.filter((item) => typeof item === "string" && /^sha256:[a-f0-9]{16}$/.test(item)).slice(0, 32)
        : [];
    const omitted = raw.omitted && typeof raw.omitted === "object" ? raw.omitted : {};
    const omittedCount = (key) => Math.max(0, Math.floor(clampNumber(omitted[key]) ?? 0));
    return {
        version: 1,
        source: "launch-resolved",
        disableAmbientExtensions: raw.disableAmbientExtensions,
        runtime: stringList(raw.runtime),
        configured: stringList(raw.configured),
        required: Array.isArray(raw.required) ? raw.required.filter((item) => typeof item === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(item)).slice(0, 32) : [],
        effective: stringList(raw.effective),
        omitted: {
            runtime: omittedCount("runtime"),
            configured: omittedCount("configured"),
            required: omittedCount("required"),
            effective: omittedCount("effective"),
        },
    };
}
function sanitizeRuntimeAcknowledgedExtensions(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    if (raw.version !== 1 || raw.source !== "child-runtime" || !Array.isArray(raw.ids))
        return undefined;
    const ids = [];
    const seen = new Set();
    for (const item of raw.ids) {
        if (typeof item !== "string" || item.length === 0 || item.length > 128 || !/^[A-Za-z0-9._:@+-]+$/.test(item) || item.includes("..") || item.includes("/") || item.includes("\\") || seen.has(item))
            continue;
        seen.add(item);
        ids.push(item);
    }
    if (ids.length === 0)
        return undefined;
    return {
        version: 1,
        source: "child-runtime",
        ids: ids.slice(0, 32),
        omitted: Math.max(0, ids.length - 32) + Math.max(0, Math.floor(clampNumber(raw.omitted) ?? 0)),
    };
}
function runtimeAcknowledgedEntry(value) {
    const sanitized = sanitizeRuntimeAcknowledgedExtensions(value);
    return sanitized ? { runtimeAcknowledgedExtensions: sanitized } : {};
}
function sanitizeTurnBudget(value) {
    if (!value || typeof value !== "object")
        return undefined;
    const raw = value;
    const maxTurns = clampNumber(raw.maxTurns);
    const graceTurns = clampNumber(raw.graceTurns);
    const turnCount = clampNumber(raw.turnCount);
    const outcome = raw.outcome === "within-budget" || raw.outcome === "wrap-up-requested" || raw.outcome === "termination-deferred" || raw.outcome === "exceeded" ? raw.outcome : undefined;
    if (maxTurns === undefined || graceTurns === undefined || turnCount === undefined || !outcome)
        return undefined;
    return {
        maxTurns,
        graceTurns,
        turnCount,
        outcome,
        ...(clampNumber(raw.wrapUpRequestedAtTurn) !== undefined ? { wrapUpRequestedAtTurn: clampNumber(raw.wrapUpRequestedAtTurn) } : {}),
        ...(clampNumber(raw.terminationDeferredAtTurn) !== undefined ? { terminationDeferredAtTurn: clampNumber(raw.terminationDeferredAtTurn) } : {}),
        ...(clampNumber(raw.exceededAtTurn) !== undefined ? { exceededAtTurn: clampNumber(raw.exceededAtTurn) } : {}),
    };
}
function sanitizeState(value, fallback) {
    return value === "queued" || value === "running" || value === "complete" || value === "failed" || value === "partial" || value === "paused" || value === "stopped" || value === "rejected"
        ? value
        : fallback;
}
function sanitizeStep(input, depth) {
    if (!input || typeof input !== "object")
        return undefined;
    const raw = input;
    const agent = stringValue(raw.agent, 128);
    if (!agent)
        return undefined;
    const status = raw.status === "pending" || raw.status === "running" || raw.status === "complete" || raw.status === "completed" || raw.status === "failed" || raw.status === "partial" || raw.status === "paused" || raw.status === "stopped" || raw.status === "rejected"
        ? raw.status
        : "pending";
    const model = stringValue(raw.model);
    const thinking = THINKING_LEVELS.find((level) => level === raw.thinking);
    return {
        agent,
        status,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
        ...(stringValue(raw.sessionName, 256) ? { sessionName: stringValue(raw.sessionName, 256) } : {}),
        ...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
        ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
        ...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
        ...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
        ...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
        ...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
        ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
        ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
        ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
        ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
        ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
        ...(raw.timedOut === true ? { timedOut: true } : {}),
        ...(raw.stopped === true ? { stopped: true } : {}),
        ...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
        ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
        ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
        ...(sanitizeLaunchResolvedExtensions(raw.launchResolvedExtensions) ? { launchResolvedExtensions: sanitizeLaunchResolvedExtensions(raw.launchResolvedExtensions) } : {}),
        ...(sanitizeRuntimeAcknowledgedExtensions(raw.runtimeAcknowledgedExtensions) ? { runtimeAcknowledgedExtensions: sanitizeRuntimeAcknowledgedExtensions(raw.runtimeAcknowledgedExtensions) } : {}),
        ...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child) => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
    };
}
export function sanitizeSummary(input, depth = 0) {
    if (!input || typeof input !== "object")
        return undefined;
    const raw = input;
    if (!isSafeNestedId(raw.id) || !isSafeNestedId(raw.parentRunId))
        return undefined;
    const pathParts = sanitizeNestedPath(raw.path);
    const steps = Array.isArray(raw.steps)
        ? raw.steps.map((step) => sanitizeStep(step, depth + 1)).filter((step) => Boolean(step)).slice(0, MAX_STEPS)
        : undefined;
    const totalTokens = sanitizeTokenUsage(raw.totalTokens);
    const totalCost = sanitizeCost(raw.totalCost);
    return {
        id: raw.id,
        parentRunId: raw.parentRunId,
        ...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
        ...(stringValue(raw.parentAgent, 128) ? { parentAgent: stringValue(raw.parentAgent, 128) } : {}),
        depth: Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH),
        path: pathParts,
        state: sanitizeState(raw.state, "running"),
        ...(stringValue(raw.sessionName, 256) ? { sessionName: stringValue(raw.sessionName, 256) } : {}),
        ...(stringValue(raw.model) ? { model: stringValue(raw.model) } : {}),
        ...(THINKING_LEVELS.find((level) => level === raw.thinking) ? { thinking: THINKING_LEVELS.find((level) => level === raw.thinking) } : {}),
        ...(stringValue(raw.asyncDir, 2048) ? { asyncDir: stringValue(raw.asyncDir, 2048) } : {}),
        ...(clampNumber(raw.pid) !== undefined && clampNumber(raw.pid) > 0 && Number.isInteger(clampNumber(raw.pid)) ? { pid: clampNumber(raw.pid) } : {}),
        ...(stringValue(raw.sessionId, 256) ? { sessionId: stringValue(raw.sessionId, 256) } : {}),
        ...(stringValue(raw.sessionFile, 2048) ? { sessionFile: stringValue(raw.sessionFile, 2048) } : {}),
        ...(stringValue(raw.intercomTarget, 256) ? { intercomTarget: stringValue(raw.intercomTarget, 256) } : {}),
        ...(stringValue(raw.ownerIntercomTarget, 256) ? { ownerIntercomTarget: stringValue(raw.ownerIntercomTarget, 256) } : {}),
        ...(stringValue(raw.leafIntercomTarget, 256) ? { leafIntercomTarget: stringValue(raw.leafIntercomTarget, 256) } : {}),
        ...(raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown" ? { ownerState: raw.ownerState } : {}),
        ...(stringValue(raw.controlInbox, 2048) ? { controlInbox: stringValue(raw.controlInbox, 2048) } : {}),
        ...(stringValue(raw.capabilityToken, 128) ? { capabilityToken: stringValue(raw.capabilityToken, 128) } : {}),
        ...(raw.mode === "single" || raw.mode === "parallel" || raw.mode === "chain" ? { mode: raw.mode } : {}),
        ...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),
        ...(Array.isArray(raw.agents) ? { agents: raw.agents.map((agent) => stringValue(agent, 128)).filter((agent) => Boolean(agent)).slice(0, MAX_STEPS) } : {}),
        ...(clampNumber(raw.currentStep) !== undefined ? { currentStep: clampNumber(raw.currentStep) } : {}),
        ...(clampNumber(raw.chainStepCount) !== undefined ? { chainStepCount: clampNumber(raw.chainStepCount) } : {}),
        ...(raw.activityState === "active_long_running" || raw.activityState === "needs_attention" ? { activityState: raw.activityState } : {}),
        ...(clampNumber(raw.lastActivityAt) !== undefined ? { lastActivityAt: clampNumber(raw.lastActivityAt) } : {}),
        ...(stringValue(raw.currentTool, 128) ? { currentTool: stringValue(raw.currentTool, 128) } : {}),
        ...(clampNumber(raw.currentToolStartedAt) !== undefined ? { currentToolStartedAt: clampNumber(raw.currentToolStartedAt) } : {}),
        ...(stringValue(raw.currentPath, 2048) ? { currentPath: stringValue(raw.currentPath, 2048) } : {}),
        ...(clampNumber(raw.turnCount) !== undefined ? { turnCount: clampNumber(raw.turnCount) } : {}),
        ...(clampNumber(raw.toolCount) !== undefined ? { toolCount: clampNumber(raw.toolCount) } : {}),
        ...(totalTokens ? { totalTokens } : {}),
        ...(totalCost ? { totalCost } : {}),
        ...(clampNumber(raw.startedAt) !== undefined ? { startedAt: clampNumber(raw.startedAt) } : {}),
        ...(clampNumber(raw.endedAt) !== undefined ? { endedAt: clampNumber(raw.endedAt) } : {}),
        ...(clampNumber(raw.lastUpdate) !== undefined ? { lastUpdate: clampNumber(raw.lastUpdate) } : {}),
        ...(clampNumber(raw.timeoutMs) !== undefined ? { timeoutMs: clampNumber(raw.timeoutMs) } : {}),
        ...(clampNumber(raw.deadlineAt) !== undefined ? { deadlineAt: clampNumber(raw.deadlineAt) } : {}),
        ...(raw.timedOut === true ? { timedOut: true } : {}),
        ...(raw.stopped === true ? { stopped: true } : {}),
        ...(sanitizeTurnBudget(raw.turnBudget) ? { turnBudget: sanitizeTurnBudget(raw.turnBudget) } : {}),
        ...(raw.turnBudgetExceeded === true ? { turnBudgetExceeded: true } : {}),
        ...(raw.wrapUpRequested === true ? { wrapUpRequested: true } : {}),
        ...(stringValue(raw.error, 1024) ? { error: stringValue(raw.error, 1024) } : {}),
        ...(sanitizeLaunchResolvedExtensions(raw.launchResolvedExtensions) ? { launchResolvedExtensions: sanitizeLaunchResolvedExtensions(raw.launchResolvedExtensions) } : {}),
        ...(sanitizeRuntimeAcknowledgedExtensions(raw.runtimeAcknowledgedExtensions) ? { runtimeAcknowledgedExtensions: sanitizeRuntimeAcknowledgedExtensions(raw.runtimeAcknowledgedExtensions) } : {}),
        ...(steps && steps.length > 0 ? { steps } : {}),
        ...(depth < MAX_DEPTH && Array.isArray(raw.children) ? { children: raw.children.map((child) => sanitizeSummary(child, depth + 1)).filter((child) => Boolean(child)).slice(0, MAX_CHILDREN) } : {}),
    };
}
function parseRecord(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.started" && raw.type !== "subagent.nested.updated" && raw.type !== "subagent.nested.completed")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.parentRunId))
        return undefined;
    const ts = clampNumber(raw.ts);
    if (ts === undefined)
        return undefined;
    const child = sanitizeSummary(raw.child);
    if (!child || child.id === route.rootRunId)
        return undefined;
    const routedChild = {
        ...child,
        controlInbox: route.controlInbox,
        capabilityToken: route.capabilityToken,
        ownerState: child.ownerState ?? "unknown",
    };
    return {
        type: raw.type,
        ts,
        rootRunId: route.rootRunId,
        parentRunId: raw.parentRunId,
        ...(clampNumber(raw.parentStepIndex) !== undefined ? { parentStepIndex: clampNumber(raw.parentStepIndex) } : {}),
        capabilityToken: route.capabilityToken,
        child: routedChild,
    };
}
export function parseNestedEventRecords(content, route) {
    if (!content.includes("\n")) {
        const record = parseRecord(content.trim(), route);
        return record ? [record] : [];
    }
    return content.split("\n")
        .slice(0, content.endsWith("\n") ? undefined : -1)
        .map((line) => line.trim() ? parseRecord(line, route) : undefined)
        .filter((event) => Boolean(event));
}
function terminal(state) {
    return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "rejected" || state === "stopped";
}
function mergeBoundedChildren(existing, incoming) {
    if (incoming === undefined)
        return existing?.slice(0, MAX_CHILDREN);
    const incomingById = new Map(incoming.map((child) => [child.id, child]));
    const merged = (existing ?? []).map((child) => incomingById.get(child.id) ?? child);
    for (const child of incoming) {
        if (!existing?.some((prior) => prior.id === child.id))
            merged.push(child);
    }
    return merged.slice(0, MAX_CHILDREN);
}
function mergeStepSummary(existing, incoming) {
    if (!existing || existing.agent !== incoming.agent)
        return { ...incoming, ...(incoming.children ? { children: incoming.children.slice(0, MAX_CHILDREN) } : {}) };
    const metadata = { ...existing };
    delete metadata.status;
    delete metadata.activityState;
    delete metadata.lastActivityAt;
    delete metadata.currentTool;
    delete metadata.currentToolStartedAt;
    delete metadata.currentPath;
    delete metadata.turnCount;
    delete metadata.toolCount;
    delete metadata.children;
    const children = mergeBoundedChildren(existing.children, incoming.children);
    return {
        ...metadata,
        ...incoming,
        ...(children ? { children } : {}),
    };
}
function mergeSummary(existing, event) {
    const incomingState = event.type === "subagent.nested.completed" && event.child.state === "running" ? "complete" : event.child.state;
    const incoming = { ...event.child, state: incomingState, lastUpdate: event.child.lastUpdate ?? event.ts };
    if (!existing)
        return incoming;
    const existingUpdate = existing.lastUpdate ?? 0;
    const incomingUpdate = incoming.lastUpdate ?? event.ts;
    if (incomingUpdate < existingUpdate)
        return existing;
    if (terminal(existing.state) && !terminal(incoming.state))
        return existing;
    if (terminal(existing.state) && terminal(incoming.state) && incomingUpdate === existingUpdate)
        return existing;
    const existingSteps = existing.steps ?? [];
    const incomingSteps = incoming.steps;
    const steps = incomingSteps === undefined
        ? existing.steps
        : Array.from({ length: Math.min(MAX_STEPS, Math.max(existingSteps.length, incomingSteps.length)) }, (_, index) => incomingSteps[index] ? mergeStepSummary(existingSteps[index], incomingSteps[index]) : existingSteps[index]).filter((step) => Boolean(step));
    const children = mergeBoundedChildren(existing.children, incoming.children);
    return {
        ...existing,
        ...incoming,
        ...(steps ? { steps } : {}),
        ...(children ? { children } : {}),
        state: incoming.state,
        lastUpdate: Math.max(existingUpdate, incomingUpdate),
    };
}
function attachChild(children, event) {
    let updated = false;
    const walk = (items) => items.map((item) => {
        if (item.id === event.parentRunId) {
            const existingChildren = item.children ?? [];
            const childIndex = existingChildren.findIndex((child) => child.id === event.child.id);
            const nextChild = mergeSummary(childIndex >= 0 ? existingChildren[childIndex] : undefined, event);
            const nextChildren = childIndex >= 0
                ? existingChildren.map((child, index) => index === childIndex ? nextChild : child)
                : [...existingChildren, nextChild];
            updated = true;
            return { ...item, children: nextChildren.slice(0, MAX_CHILDREN), lastUpdate: Math.max(item.lastUpdate ?? 0, event.ts) };
        }
        if (!item.children?.length)
            return item;
        const nextChildren = walk(item.children);
        return nextChildren === item.children ? item : { ...item, children: nextChildren };
    });
    const next = walk(children);
    if (updated)
        return next;
    const childIndex = next.findIndex((child) => child.id === event.child.id);
    const nextChild = mergeSummary(childIndex >= 0 ? next[childIndex] : undefined, event);
    return childIndex >= 0
        ? next.map((child, index) => index === childIndex ? nextChild : child)
        : [...next, nextChild].slice(0, MAX_CHILDREN);
}
export function applyNestedEvent(registry, event) {
    return {
        ...registry,
        updatedAt: Math.max(registry.updatedAt, event.ts),
        children: attachChild(registry.children, event),
    };
}
function registryPath(route) {
    return path.join(commonRouteRoot(route), REGISTRY_FILE);
}
function routeFromIndexEntry(rootRunId, filePath) {
    try {
        const metadata = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (metadata.rootRunId !== rootRunId || typeof metadata.capabilityToken !== "string" || typeof metadata.routeRoot !== "string")
            return undefined;
        const routeRoot = path.join(NESTED_EVENTS_DIR, path.basename(metadata.routeRoot));
        const route = {
            rootRunId,
            eventSink: path.join(routeRoot, "events"),
            controlInbox: path.join(routeRoot, "controls"),
            capabilityToken: metadata.capabilityToken,
        };
        validateRouteShape(route);
        if (!fs.statSync(route.eventSink).isDirectory() || !fs.statSync(route.controlInbox).isDirectory())
            return undefined;
        const routeFilePath = path.join(routeRoot, ROUTE_FILE);
        try {
            const routeFile = JSON.parse(fs.readFileSync(routeFilePath, "utf-8"));
            if (routeFile.rootRunId !== rootRunId || routeFile.capabilityToken !== metadata.capabilityToken)
                return undefined;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                return undefined;
            try {
                writeAtomicJson(routeFilePath, { rootRunId, capabilityToken: metadata.capabilityToken, createdAt: typeof metadata.createdAt === "number" ? metadata.createdAt : Date.now() });
            }
            catch {
                // The route index already carries enough data for reload lookup.
            }
        }
        return route;
    }
    catch {
        return undefined;
    }
}
export function findNestedRouteForRootId(rootRunId) {
    assertSafeId("rootRunId", rootRunId);
    let entries;
    try {
        entries = fs.readdirSync(routeIndexDir(rootRunId));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    for (const entry of entries) {
        const route = routeFromIndexEntry(rootRunId, path.join(routeIndexDir(rootRunId), entry));
        if (route)
            return route;
    }
    return undefined;
}
export function buildNestedRouteIndex() {
    const index = new Map();
    for (const route of listNestedRoutes()) {
        if (!index.has(route.rootRunId))
            index.set(route.rootRunId, route);
    }
    return index;
}
export function projectNestedRegistryForRoot(rootRunId) {
    const route = findNestedRouteForRootId(rootRunId);
    return route ? projectNestedEvents(route) : undefined;
}
export function findNestedRun(children, id) {
    if (!children?.length)
        return undefined;
    for (const child of children) {
        if (child.id === id)
            return child;
        const nested = findNestedRun(child.children, id) ?? findNestedRun(child.steps?.flatMap((step) => step.children ?? []), id);
        if (nested)
            return nested;
    }
    return undefined;
}
export function retainNestedLookupRoute(state, route, sessionId) {
    if (!route || !sessionId || sessionId !== state.currentSessionId)
        return;
    if (state.retainedNestedLookupRoutes?.sessionId !== sessionId) {
        state.retainedNestedLookupRoutes = { sessionId, routes: new Map() };
    }
    state.retainedNestedLookupRoutes.routes.set(route.rootRunId, route);
}
function collectNestedRuns(children, output = []) {
    for (const child of children ?? []) {
        output.push(child);
        collectNestedRuns(child.children, output);
        collectNestedRuns(child.steps?.flatMap((step) => step.children ?? []), output);
    }
    return output;
}
function collectScopedNestedRuns(children, scope, output = []) {
    if (!scope)
        return collectNestedRuns(children, output);
    for (const child of children ?? []) {
        if (child.parentRunId === scope.parentRunId && (scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)) {
            collectNestedRuns([child], output);
            continue;
        }
        collectScopedNestedRuns(child.children, scope, output);
        collectScopedNestedRuns(child.steps?.flatMap((step) => step.children ?? []), scope, output);
    }
    return output;
}
function listNestedRoutes() {
    let rootEntries;
    try {
        rootEntries = fs.readdirSync(routeIndexRoot());
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const routes = [];
    for (const rootEntry of rootEntries) {
        let rootRunId;
        try {
            rootRunId = decodeURIComponent(rootEntry);
        }
        catch {
            continue;
        }
        try {
            for (const entry of fs.readdirSync(path.join(routeIndexRoot(), rootEntry))) {
                const route = routeFromIndexEntry(rootRunId, path.join(routeIndexRoot(), rootEntry, entry));
                if (route)
                    routes.push(route);
            }
        }
        catch {
            continue;
        }
    }
    return routes;
}
export function findNestedRunMatchesById(id, options = {}) {
    assertSafeId("id", id);
    const matches = [];
    for (const route of options.scope?.routes ?? listNestedRoutes()) {
        try {
            const registry = projectNestedEvents(route);
            for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
                if (options.prefix ? run.id.startsWith(id) : run.id === id)
                    matches.push({ rootRunId: route.rootRunId, route, run });
            }
        }
        catch {
            continue;
        }
    }
    return matches;
}
export function findNestedRunById(id) {
    const match = findNestedRunMatchesById(id)[0];
    return match ? { rootRunId: match.rootRunId, run: match.run } : undefined;
}
export function readNestedRegistry(route) {
    validateRouteShape(route);
    try {
        const parsed = JSON.parse(fs.readFileSync(registryPath(route), "utf-8"));
        return {
            rootRunId: route.rootRunId,
            updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
            children: Array.isArray(parsed.children) ? parsed.children.map((child) => sanitizeSummary(child)).filter((child) => Boolean(child)) : [],
            processedEvents: Array.isArray(parsed.processedEvents) ? parsed.processedEvents.filter((item) => typeof item === "string") : [],
        };
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        return { rootRunId: route.rootRunId, updatedAt: 0, children: [], processedEvents: [] };
    }
}
export function projectNestedEvents(route) {
    validateRouteShape(route);
    let registry = readNestedRegistry(route);
    const seen = new Set(registry.processedEvents);
    let changed = false;
    let entries = [];
    try {
        entries = fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl")).sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    for (const entry of entries) {
        if (seen.has(entry))
            continue;
        const eventPath = path.join(route.eventSink, entry);
        if (!containedPath(route.eventSink, eventPath))
            continue;
        let content;
        try {
            const stat = fs.statSync(eventPath);
            if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                continue;
            content = fs.readFileSync(eventPath, "utf-8");
        }
        catch {
            continue;
        }
        const records = parseNestedEventRecords(content, route);
        if (records.length === 0)
            continue;
        for (const event of records) {
            registry = applyNestedEvent(registry, event);
            changed = true;
        }
        seen.add(entry);
        changed = true;
    }
    if (changed) {
        const processedEvents = [...seen];
        const retainedEvents = processedEvents.slice(-1000);
        const evictedEvents = processedEvents.slice(0, -1000);
        registry = { ...registry, processedEvents: retainedEvents };
        // Parent projection is the only writer to this sidecar registry. Child and
        // runner processes only create immutable event files, so parent status.json
        // remains owned by the existing runner writer and is never rewritten here.
        writeAtomicJson(registryPath(route), registry);
        // The registry retains only a bounded filename cursor. Remove the old
        // immutable status records after the cursor is durable; otherwise an evicted
        // filename is rediscovered on the next projection and replayed forever.
        for (const entry of evictedEvents) {
            const eventPath = path.join(route.eventSink, entry);
            if (!containedPath(route.eventSink, eventPath))
                continue;
            try {
                const stat = fs.statSync(eventPath);
                if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                    continue;
                const content = fs.readFileSync(eventPath, "utf-8");
                const hasStatusRecord = parseNestedEventRecords(content, route).length > 0;
                const hasControlResult = content
                    .split("\n")
                    .some((line) => line.trim() && parseControlResult(line.trim(), route));
                if (hasStatusRecord && !hasControlResult)
                    fs.unlinkSync(eventPath);
            }
            catch {
                // A cleanup failure must not make a successfully projected status fail.
            }
        }
    }
    return registry;
}
function writeRouteRecord(dir, ts, payload) {
    const content = `${JSON.stringify(payload)}\n`;
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        throw new Error("Nested route record exceeds the maximum size.");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const name = `${String(ts).padStart(13, "0")}-${randomUUID()}.json`;
    const tmp = path.join(dir, `.${name}.tmp`);
    const finalPath = path.join(dir, name);
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, finalPath);
    return finalPath;
}
export function writeNestedEvent(route, event) {
    validateRouteShape(route);
    const record = {
        ...event,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseRecord(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested event record failed validation.");
    writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}
function parseControlRequest(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.control-request")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId))
        return undefined;
    if (raw.action !== "interrupt" && raw.action !== "resume")
        return undefined;
    const ts = clampNumber(raw.ts);
    if (ts === undefined)
        return undefined;
    return {
        type: "subagent.nested.control-request",
        ts,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
        requestId: raw.requestId,
        targetRunId: raw.targetRunId,
        action: raw.action,
        ...(stringValue(raw.message, 16_000) ? { message: stringValue(raw.message, 16_000) } : {}),
    };
}
function parseControlResult(content, route) {
    if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object")
        return undefined;
    const raw = parsed;
    if (raw.type !== "subagent.nested.control-result")
        return undefined;
    if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken)
        return undefined;
    if (!isSafeNestedId(raw.requestId) || !isSafeNestedId(raw.targetRunId))
        return undefined;
    const ts = clampNumber(raw.ts);
    if (ts === undefined || typeof raw.ok !== "boolean")
        return undefined;
    return {
        type: "subagent.nested.control-result",
        ts,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
        requestId: raw.requestId,
        targetRunId: raw.targetRunId,
        ok: raw.ok,
        message: stringValue(raw.message, 16_000) ?? (raw.ok ? "Control request completed." : "Control request failed."),
    };
}
export function writeNestedControlRequest(route, request) {
    validateRouteShape(route);
    assertSafeId("requestId", request.requestId);
    assertSafeId("targetRunId", request.targetRunId);
    const record = {
        type: "subagent.nested.control-request",
        ...request,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseControlRequest(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested control request failed validation.");
    return writeRouteRecord(route.controlInbox, sanitized.ts, sanitized);
}
export function readNestedControlRequests(route) {
    validateRouteShape(route);
    let entries = [];
    try {
        entries = fs.readdirSync(route.controlInbox).filter((entry) => entry.endsWith(".json")).sort();
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const requests = [];
    for (const entry of entries) {
        const filePath = path.join(route.controlInbox, entry);
        if (!containedPath(route.controlInbox, filePath))
            continue;
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
                continue;
            const request = parseControlRequest(fs.readFileSync(filePath, "utf-8"), route);
            if (request)
                requests.push({ ...request, filePath });
        }
        catch {
            continue;
        }
    }
    return requests;
}
export function writeNestedControlResult(route, result) {
    validateRouteShape(route);
    assertSafeId("requestId", result.requestId);
    assertSafeId("targetRunId", result.targetRunId);
    const record = {
        type: "subagent.nested.control-result",
        ...result,
        rootRunId: route.rootRunId,
        capabilityToken: route.capabilityToken,
    };
    const sanitized = parseControlResult(JSON.stringify(record), route);
    if (!sanitized)
        throw new Error("Nested control result failed validation.");
    writeRouteRecord(route.eventSink, sanitized.ts, sanitized);
}
function readControlResultsFromFile(route, eventPath) {
    if (!containedPath(route.eventSink, eventPath))
        return [];
    try {
        const stat = fs.statSync(eventPath);
        if (!stat.isFile() || stat.size > MAX_EVENT_BYTES)
            return [];
        const content = fs.readFileSync(eventPath, "utf-8");
        const lines = content.includes("\n") ? content.split("\n").filter((line) => line.trim()) : [content];
        return lines.map((line) => parseControlResult(line, route)).filter((result) => Boolean(result));
    }
    catch {
        return [];
    }
}
function listNestedEventFiles(route) {
    validateRouteShape(route);
    try {
        return fs.readdirSync(route.eventSink).filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
}
export function snapshotNestedEventFiles(route) {
    return new Set(listNestedEventFiles(route));
}
export function findNestedControlResult(route, requestId, targetRunId, ignoredFiles) {
    const entries = listNestedEventFiles(route)
        .filter((entry) => !ignoredFiles.has(entry))
        .sort()
        .reverse();
    for (const entry of entries) {
        const result = readControlResultsFromFile(route, path.join(route.eventSink, entry))
            .find((candidate) => candidate.requestId === requestId && candidate.targetRunId === targetRunId);
        if (result)
            return result;
    }
    return undefined;
}
export function readNestedControlResults(route) {
    return listNestedEventFiles(route)
        .sort()
        .flatMap((entry) => readControlResultsFromFile(route, path.join(route.eventSink, entry)));
}
export function attachRootChildrenToSteps(rootRunId, steps, children) {
    if (!steps?.length)
        return;
    for (const step of steps) {
        step.children = undefined;
    }
    if (!children?.length)
        return;
    for (const child of children) {
        if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined)
            continue;
        const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
        if (!step)
            continue;
        step.children ??= [];
        step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(0, MAX_CHILDREN);
    }
}
export function updateAsyncJobNestedProjection(job) {
    if (!job.nestedRoute)
        return;
    const registry = projectNestedEvents(job.nestedRoute);
    job.nestedChildren = registry.children;
    attachRootChildrenToSteps(job.asyncId, job.steps, registry.children);
}
export function updateForegroundNestedProjection(control) {
    if (!control.nestedRoute)
        return;
    const registry = projectNestedEvents(control.nestedRoute);
    control.nestedChildren = registry.children;
}
export function hasLiveNestedDescendants(children) {
    if (!children?.length)
        return false;
    for (const child of children) {
        if (!terminal(child.state))
            return true;
        if (hasLiveNestedDescendants(child.children))
            return true;
        if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? [])))
            return true;
    }
    return false;
}
export function nestedSummaryFromAsyncStatus(status, asyncDir, fallback) {
    return {
        id: status.runId || fallback.id,
        parentRunId: fallback.parentRunId,
        ...(fallback.parentStepIndex !== undefined ? { parentStepIndex: fallback.parentStepIndex } : {}),
        depth: fallback.depth,
        path: fallback.path ?? [{ runId: fallback.parentRunId, ...(fallback.parentStepIndex !== undefined ? { stepIndex: fallback.parentStepIndex } : {}) }],
        asyncDir,
        ...(status.pid ? { pid: status.pid } : {}),
        ...(status.sessionId ? { sessionId: status.sessionId } : {}),
        mode: status.mode ?? fallback.mode,
        ...(status.steps?.length === 1 && status.steps[0]?.model ? { model: status.steps[0].model } : {}),
        ...(status.steps?.length === 1 && status.steps[0]?.thinking ? { thinking: status.steps[0].thinking } : {}),
        ...(status.steps?.length === 1 && status.steps[0]?.sessionName ? { sessionName: status.steps[0].sessionName } : {}),
        ...(status.processTerminal ? { processTerminal: sanitizeProcessTerminal(status.processTerminal, { runId: status.runId || fallback.id, runnerProcessInstanceId: status.processTerminal.runnerProcessInstanceId }, `${asyncDir}/status.json`) } : {}),
        ...(status.launchResolvedExtensions ? { launchResolvedExtensions: status.launchResolvedExtensions } : {}),
        ...runtimeAcknowledgedEntry(status.runtimeAcknowledgedExtensions),
        ...(status.capabilityCeiling ? { capabilityCeiling: status.capabilityCeiling } : {}),
        ...(status.capabilityAudit ? { capabilityAudit: status.capabilityAudit } : {}),
        state: status.state,
        ...(status.currentStep !== undefined ? { currentStep: status.currentStep } : {}),
        ...(status.chainStepCount !== undefined ? { chainStepCount: status.chainStepCount } : {}),
        ...(status.activityState ? { activityState: status.activityState } : {}),
        ...(status.lastActivityAt !== undefined ? { lastActivityAt: status.lastActivityAt } : {}),
        ...(status.currentTool ? { currentTool: status.currentTool } : {}),
        ...(status.currentToolStartedAt !== undefined ? { currentToolStartedAt: status.currentToolStartedAt } : {}),
        ...(status.currentPath ? { currentPath: status.currentPath } : {}),
        ...(status.turnCount !== undefined ? { turnCount: status.turnCount } : {}),
        ...(status.toolCount !== undefined ? { toolCount: status.toolCount } : {}),
        ...(status.totalTokens ? { totalTokens: status.totalTokens } : {}),
        ...(status.timeoutMs !== undefined ? { timeoutMs: status.timeoutMs } : {}),
        ...(status.deadlineAt !== undefined ? { deadlineAt: status.deadlineAt } : {}),
        ...(status.timedOut !== undefined ? { timedOut: status.timedOut } : {}),
        ...(status.stopped !== undefined ? { stopped: status.stopped } : {}),
        ...(status.turnBudget ? { turnBudget: status.turnBudget } : {}),
        ...(status.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: status.turnBudgetExceeded } : {}),
        ...(status.wrapUpRequested !== undefined ? { wrapUpRequested: status.wrapUpRequested } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.startedAt !== undefined ? { startedAt: status.startedAt } : { startedAt: fallback.ts }),
        ...(status.endedAt !== undefined ? { endedAt: status.endedAt } : {}),
        lastUpdate: status.lastUpdate ?? fallback.ts,
        ...(status.sessionFile ? { sessionFile: status.sessionFile } : {}),
        ...(status.steps?.length ? { steps: status.steps.map((step, index) => ({
                agent: step.agent,
                ...(step.sessionName ? { sessionName: step.sessionName } : {}),
                status: step.status,
                ...(step.model ? { model: step.model } : {}),
                ...(step.thinking ? { thinking: step.thinking } : {}),
                ...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
                ...(step.activityState ? { activityState: step.activityState } : {}),
                ...(step.lastActivityAt !== undefined ? { lastActivityAt: step.lastActivityAt } : {}),
                ...(step.currentTool ? { currentTool: step.currentTool } : {}),
                ...(step.currentToolStartedAt !== undefined ? { currentToolStartedAt: step.currentToolStartedAt } : {}),
                ...(step.currentPath ? { currentPath: step.currentPath } : {}),
                ...(step.turnCount !== undefined ? { turnCount: step.turnCount } : {}),
                ...(step.toolCount !== undefined ? { toolCount: step.toolCount } : {}),
                ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
                ...(step.endedAt !== undefined ? { endedAt: step.endedAt } : {}),
                ...(step.error ? { error: step.error } : {}),
                ...(step.launchResolvedExtensions ? { launchResolvedExtensions: step.launchResolvedExtensions } : {}),
                ...runtimeAcknowledgedEntry(step.runtimeAcknowledgedExtensions),
                ...(step.timedOut !== undefined ? { timedOut: step.timedOut } : {}),
                ...(step.stopped !== undefined ? { stopped: step.stopped } : {}),
                ...(step.turnBudget ? { turnBudget: step.turnBudget } : {}),
                ...(step.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: step.turnBudgetExceeded } : {}),
                ...(step.wrapUpRequested !== undefined ? { wrapUpRequested: step.wrapUpRequested } : {}),
                ...(step.processTerminal ? { processTerminal: sanitizeProcessTerminal(step.processTerminal, { runId: status.runId || fallback.id, runnerProcessInstanceId: step.processTerminal.runnerProcessInstanceId }, `${asyncDir}/status.json step ${index}`) } : {}),
                ...(step.capabilityCeiling ? { capabilityCeiling: step.capabilityCeiling } : {}),
                ...(step.capabilityAudit ? { capabilityAudit: step.capabilityAudit } : {}),
            })).slice(0, MAX_STEPS) } : {}),
    };
}
export function isTopLevelAsyncDir(asyncDir) {
    const resolved = path.resolve(asyncDir);
    return containedPath(DIRS.async, resolved) && !containedPath(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"), resolved);
}
export function nestedRunScope(rootRunId) {
    assertSafeId("rootRunId", rootRunId);
    return {
        asyncDirRoot: path.join(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId),
        resultsDir: path.join(DIRS.results, "nested", rootRunId),
    };
}
export function nestedResultsPath(rootRunId, id) {
    assertSafeId("id", id);
    return path.join(nestedRunScope(rootRunId).resultsDir, `${id}.json`);
}
//# sourceMappingURL=nested-events.js.map