import * as fs from "node:fs";
import * as path from "node:path";
import { buildCompletionKey, markSeenWithTtl } from "./completion-dedupe.js";
import { createFileCoalescer } from "../../shared/file-coalescer.js";
import { shouldUseNativeFsWatch } from "../../shared/watch-strategy.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT, } from "../../shared/types.js";
import { attachNestedChildrenToResultChildren, buildSubagentResultIntercomPayload, compactNestedResultChildren, deliverSubagentResultIntercomEvent, resolveSubagentResultStatus, } from "../../intercom/result-intercom.js";
import { projectNestedRegistryForRoot, sanitizeSummary } from "../shared/nested-events.js";
import { resolveWatchPath } from "../../shared/utils.js";
import { recordWaitCompletion } from "./wait-completions.js";
import { MISSION_BINDING_FILE, syncMissionFromAsyncCompletion } from "../../missions/lifecycle.js";
import { acknowledgeMissionObserverSnapshot, missionObserverResultCandidateFiles, promotePendingResultFile, readResultPayload, resultCandidateFilesForSession, resultPayloadPathForIndexedRun, resultPayloadPathForMissionObserverRun, resultPayloadPathForSessionRun, resultSnapshotReplaced, retireResultSnapshot, withResultRunLease, writeAsyncResultFile, writeResultIndexForData } from "./result-files.js";
const WATCHER_RESTART_DELAY_MS = 3000;
const POLL_INTERVAL_MS = 3000;
const HEALTHY_SCAN_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 100;
const SLOW_RESULT_SCAN_MS = 500;
function jsonStringProperty(raw, property) {
    const matches = raw.matchAll(new RegExp(`"${property}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "g"));
    let encoded;
    for (const match of matches)
        encoded = match[1];
    if (!encoded)
        return undefined;
    try {
        const value = JSON.parse(encoded);
        return typeof value === "string" && value ? value : undefined;
    }
    catch {
        return undefined;
    }
}
function resultFileIdentity(raw, file) {
    return {
        sessionId: jsonStringProperty(raw, "sessionId"),
        completionOwnerId: jsonStringProperty(raw, "completionOwnerId"),
        runId: file.replace(/\.json$/i, ""),
        asyncDir: jsonStringProperty(raw, "asyncDir"),
    };
}
function sanitizeNestedResultChildren(value, resultPath, label) {
    if (value === undefined)
        return undefined;
    if (!Array.isArray(value)) {
        console.error(`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`);
        return undefined;
    }
    const children = value.map((child) => sanitizeSummary(child)).filter((child) => Boolean(child));
    if (children.length !== value.length) {
        console.error(`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`);
    }
    return children.length ? children : undefined;
}
function errorCode(error) {
    return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
function isNotFound(error) {
    return errorCode(error) === "ENOENT";
}
function isAbsentResultCandidate(error) {
    return isNotFound(error) || errorCode(error) === "ENAMETOOLONG";
}
function isAccessDenied(error) {
    const code = errorCode(error);
    return code === "EPERM" || code === "EACCES";
}
function shouldPoll(error) {
    const code = errorCode(error);
    return code === "EMFILE" || code === "ENOSPC";
}
function hasDeliveredNotification(data) {
    return typeof data.notificationDeliveredAt === "number" && Number.isFinite(data.notificationDeliveredAt);
}
/** Marks the payload that was delivered, unless a newer payload replaced it (then returns undefined). */
function markDeliveredNotification(resultPath, data, read, now) {
    const marked = { ...data, runId: read.runId, notificationDeliveredAt: now };
    return withResultRunLease(path.dirname(resultPath), read.runId, () => {
        if (resultSnapshotReplaced(resultPath, read))
            return undefined;
        const { state } = writeAsyncResultFile(resultPath, marked);
        // writeAsyncResultFile writes JSON.stringify(payload, null, 2). A denied promotion leaves the
        // older public payload in place.
        const snapshot = JSON.stringify(marked, null, 2);
        const stalePublic = state === "pending" ? readResultPayload(resultPath) : undefined;
        return { data: marked, read: { ...read, snapshot, stalePublic } };
    });
}
/**
 * Watches persisted async results for the session currently owned by this
 * runtime. `stopResultWatcher()` revokes ownership before closing resources,
 * so old callbacks can never emit or delete after reload/session replacement.
 */
export function createResultWatcher(pi, state, resultsDir, completionTtlMs, deps = {}) {
    const fsApi = deps.fs ?? fs;
    const timers = deps.timers ?? { setTimeout, clearTimeout, setInterval, clearInterval };
    const notifier = deps.notifier ?? { deliver: async () => true };
    const parseResult = deps.parseResult ?? ((raw) => JSON.parse(raw));
    const deliverIntercomResults = deps.deliverIntercomResults !== false;
    const pendingTriggerTurn = new Map();
    const processing = new Set();
    const handling = new Set();
    // While deliverPendingResults runs, completions skip the batch delay.
    let deliveringPending = 0;
    const identityCache = new Map();
    let deliveryActive = true;
    let deliveryEpoch = 0;
    let resultScanTimer = null;
    // The sole in-memory ownership lease. It is acquired for one active session
    // and revoked before the watcher, queues, or callbacks are torn down.
    let activeSessionId = null;
    const ownsResult = deps.ownership?.owns
        ?? ((sessionId, completionOwnerId) => sessionId === state.currentSessionId
            && typeof completionOwnerId === "string"
            && completionOwnerId === state.completionOwnerId);
    const claimedSessionIds = () => deps.ownership?.claimedSessionIds() ?? [];
    const ownsCompletion = (sessionId, completionOwnerId, epoch) => {
        if (!deliveryActive || epoch !== deliveryEpoch)
            return false;
        if (!activeSessionId && state.currentSessionId)
            activeSessionId = state.currentSessionId;
        return activeSessionId === state.currentSessionId && ownsResult(sessionId, completionOwnerId);
    };
    const scheduleResult = (file, triggerTurn, delayMs = 0) => {
        const pendingMode = pendingTriggerTurn.get(file);
        pendingTriggerTurn.set(file, pendingMode === false || !triggerTurn ? false : true);
        state.resultFileCoalescer.schedule(file, delayMs);
    };
    const publicResultPath = (file) => path.join(resultsDir, file);
    const publicResultFileExists = (file) => {
        try {
            return fsApi.statSync(publicResultPath(file)).isFile();
        }
        catch (error) {
            if (!isAbsentResultCandidate(error))
                console.error(`Failed to inspect subagent result file '${publicResultPath(file)}':`, error);
            return false;
        }
    };
    const resultPayloadPath = (file, observed) => {
        if (file !== path.basename(file) || !file.endsWith(".json"))
            return undefined;
        const runId = file.replace(/\.json$/i, "");
        for (const sessionId of [state.currentSessionId, ...claimedSessionIds()]) {
            if (!sessionId)
                continue;
            const sessionResult = resultPayloadPathForSessionRun(resultsDir, sessionId, runId);
            if (sessionResult)
                return sessionResult;
        }
        const observerResult = resultPayloadPathForMissionObserverRun(resultsDir, runId);
        if (observerResult)
            return observerResult;
        if (observed?.has(runId)) {
            const indexedResult = resultPayloadPathForIndexedRun(resultsDir, runId);
            if (indexedResult)
                return indexedResult;
        }
        return publicResultFileExists(file) ? publicResultPath(file) : undefined;
    };
    const resultSignature = (file, observed) => {
        const resultPath = resultPayloadPath(file, observed);
        if (!resultPath) {
            identityCache.delete(file);
            return undefined;
        }
        try {
            const stat = fsApi.statSync(resultPath);
            if (!stat.isFile())
                return undefined;
            return `${resultPath}:${stat.size}:${stat.mtimeMs}`;
        }
        catch (error) {
            identityCache.delete(file);
            if (isAccessDenied(error))
                throw error;
            if (!isAbsentResultCandidate(error))
                console.error(`Failed to inspect subagent result file '${resultPath}':`, error);
            return undefined;
        }
    };
    const inspectResult = (file, knownSignature, observed) => {
        const resultPath = resultPayloadPath(file, observed);
        if (!resultPath)
            return undefined;
        try {
            const signature = knownSignature ?? resultSignature(file, observed);
            if (!signature)
                return undefined;
            const cached = identityCache.get(file);
            if (cached?.signature === signature)
                return { identity: cached.identity, signature };
            const identity = resultFileIdentity(fsApi.readFileSync(resultPath, "utf-8"), file);
            identityCache.set(file, { signature, identity });
            return { identity, signature };
        }
        catch (error) {
            identityCache.delete(file);
            if (isAccessDenied(error))
                throw error;
            if (!isAbsentResultCandidate(error))
                console.error(`Failed to inspect subagent result file '${resultPath}':`, error);
            return undefined;
        }
    };
    const observedRunIds = () => {
        try {
            return new Set(deps.observedCompletionRunIds?.() ?? []);
        }
        catch (error) {
            console.error("Failed to inspect observed subagent completion ids:", error);
            return new Set();
        }
    };
    const shouldProcessResult = (file, observed, knownSignature) => {
        const inspected = inspectResult(file, knownSignature, observed);
        if (!inspected)
            return false;
        const { identity } = inspected;
        // Missing identity stays on the normal parser path so malformed or legacy
        // files keep their existing diagnostics and compatibility behavior.
        if (!identity.sessionId)
            return true;
        if (ownsResult(identity.sessionId, identity.completionOwnerId))
            return true;
        if (identity.asyncDir && fsApi.existsSync(path.join(identity.asyncDir, MISSION_BINDING_FILE)))
            return true;
        if (identity.runId && (observed ?? observedRunIds()).has(identity.runId))
            return true;
        return Boolean(deps.observeCompletion && !deps.observedCompletionRunIds);
    };
    const removeDeliveredResult = (file, triggerTurn, read) => {
        identityCache.delete(file);
        try {
            if (retireResultSnapshot(publicResultPath(file), read) === "replaced")
                scheduleResult(file, triggerTurn);
        }
        catch (error) {
            if (isAbsentResultCandidate(error))
                return;
            console.error(`Failed to remove delivered subagent result '${publicResultPath(file)}'; will retry:`, error);
            scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
        }
    };
    const handleResult = async (file, triggerTurn) => {
        if (processing.has(file))
            return;
        let observed;
        try {
            if (!shouldProcessResult(file)) {
                const runId = file === path.basename(file) && file.endsWith(".json") ? file.replace(/\.json$/i, "") : undefined;
                observed = observedRunIds();
                if (!runId || !observed.has(runId) || !shouldProcessResult(file, observed))
                    return;
            }
        }
        catch (error) {
            if (!isAccessDenied(error))
                throw error;
            console.error(`Failed to inspect subagent result file '${publicResultPath(file)}'; will retry:`, error);
            scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
            return;
        }
        processing.add(file);
        let rereadReplacedPayload = false;
        let resultPath = publicResultPath(file);
        // The public payload is read just before the payload itself, so anything published after the
        // read differs from both.
        let publicAtRead;
        const readPayload = (payloadPath) => {
            publicAtRead = readResultPayload(publicResultPath(file));
            return fsApi.readFileSync(payloadPath, "utf-8");
        };
        try {
            const payloadPath = resultPayloadPath(file, observed);
            if (!payloadPath)
                return;
            resultPath = payloadPath;
            let raw = readPayload(resultPath);
            let identity = resultFileIdentity(raw, file);
            if (identity.sessionId && identity.runId) {
                const pendingState = promotePendingResultFile(resultsDir, identity.sessionId, identity.runId, file);
                if (pendingState === "promoted") {
                    identityCache.delete(file);
                    resultPath = publicResultPath(file);
                    raw = readPayload(resultPath);
                    identity = resultFileIdentity(raw, file);
                }
                else if (pendingState === "pending") {
                    const pendingPath = resultPayloadPathForSessionRun(resultsDir, identity.sessionId, identity.runId);
                    if (!pendingPath) {
                        scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                        return;
                    }
                    resultPath = pendingPath;
                    raw = readPayload(resultPath);
                    identity = resultFileIdentity(raw, file);
                }
            }
            let data = parseResult(raw);
            if (typeof data.sessionId !== "string" || !data.sessionId)
                return;
            const sessionId = data.sessionId;
            const completionOwnerId = data.completionOwnerId;
            const runId = typeof data.runId === "string" && data.runId
                ? data.runId
                : typeof data.id === "string" && data.id ? data.id : file.replace(/\.json$/i, "");
            const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : undefined;
            let read = { runId, sessionId, toolCallId, snapshot: raw, ...(publicAtRead !== undefined && publicAtRead !== raw ? { stalePublic: publicAtRead } : {}) };
            const markReplacedPayload = () => {
                try {
                    if (!resultSnapshotReplaced(publicResultPath(file), read))
                        return false;
                }
                catch (error) {
                    if (isAccessDenied(error))
                        throw error;
                    console.error(`Failed to re-read subagent result file '${publicResultPath(file)}':`, error);
                }
                identityCache.delete(file);
                rereadReplacedPayload = true;
                return true;
            };
            let observerSucceeded = true;
            try {
                syncMissionFromAsyncCompletion({ ...data, runId });
            }
            catch (error) {
                observerSucceeded = false;
                console.error(`Mission completion sync failed for '${resultPath}':`, error);
            }
            try {
                deps.observeCompletion?.({ ...data, runId });
            }
            catch (error) {
                observerSucceeded = false;
                console.error(`Completion observer failed for '${resultPath}':`, error);
            }
            if (observerSucceeded) {
                try {
                    if (acknowledgeMissionObserverSnapshot(publicResultPath(file), read) === "replaced")
                        rereadReplacedPayload = true;
                }
                catch (error) {
                    observerSucceeded = false;
                    console.error(`Failed to acknowledge the mission observer for '${resultPath}'; will retry:`, error);
                }
            }
            const epoch = deliveryEpoch;
            if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                return;
            // Recorded before dedupe and before the unlink below so bg_wait can
            // use the in-memory record or its bounded durable replay after cleanup.
            const completionPersisted = recordWaitCompletion(state, runId, data, Date.now(), completionTtlMs, {
                resultsDir,
                sessionId,
            });
            const hasExplicitNestedChildren = data.nestedChildren !== undefined;
            let nestedChildren = compactNestedResultChildren(sanitizeNestedResultChildren(data.nestedChildren, resultPath, "nestedChildren"));
            if (!nestedChildren?.length && !hasExplicitNestedChildren) {
                try {
                    nestedChildren = compactNestedResultChildren(projectNestedRegistryForRoot(runId)?.children);
                }
                catch (error) {
                    console.error(`Failed to enrich subagent result file '${resultPath}' with nested registry children; will retry later:`, error);
                    scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                    return;
                }
            }
            const completionKey = buildCompletionKey(data, `result:${file}`);
            const alreadyDelivered = hasDeliveredNotification(data);
            const lastSeenAt = state.completionSeen.get(completionKey);
            if (lastSeenAt !== undefined && Date.now() - lastSeenAt > completionTtlMs) {
                state.completionSeen.delete(completionKey);
            }
            else if (lastSeenAt !== undefined) {
                if (!observerSucceeded) {
                    scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                    return;
                }
                if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                    return;
                if (markReplacedPayload())
                    return;
                deps.onResultDelivered?.(runId);
                if (!completionPersisted) {
                    scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                    return;
                }
                removeDeliveredResult(file, triggerTurn, read);
                return;
            }
            const hasResultChildren = Array.isArray(data.results) && data.results.length > 0;
            const resultChildren = hasResultChildren
                ? data.results
                : [{ agent: data.agent ?? undefined, output: data.summary, outputState: "unknown", success: data.success }];
            const normalizedChildren = attachNestedChildrenToResultChildren(runId, resultChildren.map((result = {}, index) => {
                const baseOutput = hasResultChildren ? result.output : result.output ?? data.summary;
                const hasRealOutput = typeof baseOutput === "string" && baseOutput.trim().length > 0;
                const structuredPreview = result.structuredOutput === undefined ? undefined : JSON.stringify(result.structuredOutput, null, 2).slice(0, 4_000);
                const output = hasRealOutput ? baseOutput : structuredPreview ? `Structured output:\n${structuredPreview}` : "(no output)";
                const summary = result.success === false && result.error
                    ? `${result.error}${hasRealOutput ? `\n\nOutput:\n${baseOutput}` : ""}`
                    : output;
                const sessionPath = result.sessionFile ?? (resultChildren.length === 1 ? data.sessionFile : undefined);
                const childNestedChildren = sanitizeNestedResultChildren(result.children, resultPath, `results[${index}].children`);
                const childState = result.state === "running" || result.state === "queued" || result.state === "paused" || result.state === "stopped"
                    ? result.state
                    : result.stopped === true
                        ? "stopped"
                        : data.state === "paused" || (!hasResultChildren && (data.state === "stopped" || typeof result.success !== "boolean"))
                            ? data.state
                            : undefined;
                return {
                    agent: result.agent ?? data.agent ?? `step-${index + 1}`,
                    ...(result.sessionName ? { sessionName: result.sessionName } : {}),
                    status: resolveSubagentResultStatus({
                        success: result.success,
                        state: childState,
                        interrupted: result.interrupted,
                        timedOut: result.timedOut,
                        stopped: result.stopped,
                        turnBudgetExceeded: result.turnBudgetExceeded,
                        processSignal: result.processSignal,
                    }),
                    outputState: result.outputState === "present" || result.outputState === "absent" || result.outputState === "unknown"
                        ? result.outputState
                        : "unknown",
                    ...(result.outputPartial === true ? { outputPartial: true } : {}),
                    summary,
                    index,
                    artifactPath: result.artifactPaths?.outputPath,
                    ...(typeof sessionPath === "string" && fsApi.existsSync(sessionPath) ? { sessionPath } : {}),
                    ...(result.intercomTarget ? { intercomTarget: result.intercomTarget } : {}),
                    ...(childNestedChildren ? { children: childNestedChildren } : {}),
                };
            }), nestedChildren);
            if (alreadyDelivered) {
                markSeenWithTtl(state.completionSeen, completionKey, Date.now(), completionTtlMs);
                if (!observerSucceeded) {
                    scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                    return;
                }
                if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                    return;
                if (markReplacedPayload())
                    return;
                deps.onResultDelivered?.(runId);
                if (!completionPersisted) {
                    scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                    return;
                }
                removeDeliveredResult(file, triggerTurn, read);
                return;
            }
            const intercomTarget = data.intercomTarget?.trim();
            let intercomDelivered = false;
            if (deliverIntercomResults && intercomTarget && triggerTurn) {
                const mode = data.mode === "single" || data.mode === "parallel" || data.mode === "chain" || data.mode === "workflow"
                    ? data.mode
                    : resultChildren.length > 1 ? "chain" : "single";
                intercomDelivered = await deliverSubagentResultIntercomEvent(pi.events, buildSubagentResultIntercomPayload({
                    to: intercomTarget,
                    runId,
                    mode,
                    source: "async",
                    children: normalizedChildren,
                    asyncId: data.id ?? undefined,
                    asyncDir: data.asyncDir,
                    ...(data.parallelHandoff ? { parallelHandoff: data.parallelHandoff } : {}),
                }));
                if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                    return;
                if (!intercomDelivered)
                    console.error(`Subagent async grouped result intercom delivery was not acknowledged for '${resultPath}'.`);
            }
            const delivery = notifier.deliver({
                ...data,
                id: data.id ?? runId,
                runId,
                triggerTurn,
                intercomDelivered,
                ...(nestedChildren?.length ? { nestedChildren } : {}),
                ...(Array.isArray(data.results) ? {
                    results: hasResultChildren ? normalizedChildren.map((child, index) => ({
                        ...data.results[index],
                        agent: child.agent,
                        status: child.status,
                        summary: child.summary,
                        index: child.index,
                        artifactPath: child.artifactPath,
                        sessionPath: child.sessionPath,
                        children: child.children,
                    })) : [],
                } : {}),
            });
            if (deliveringPending > 0)
                notifier.flush?.();
            const accepted = await delivery;
            if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                return;
            if (!accepted) {
                scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                return;
            }
            // A newer payload replaced this one; keep the hold until that one is delivered.
            if (markReplacedPayload())
                return;
            deps.onResultDelivered?.(runId);
            try {
                const marked = markDeliveredNotification(publicResultPath(file), data, read, Date.now());
                identityCache.delete(file);
                if (!marked) {
                    rereadReplacedPayload = true;
                    return;
                }
                ({ data, read } = marked);
            }
            catch (error) {
                console.error(`Failed to mark subagent result notification delivered for '${resultPath}'; will retry:`, error);
                scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                return;
            }
            markSeenWithTtl(state.completionSeen, completionKey, Date.now(), completionTtlMs);
            try {
                pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
                    ...data,
                    runId,
                    triggerTurn,
                    intercomDelivered,
                    ...(nestedChildren?.length ? { nestedChildren } : {}),
                    ...(Array.isArray(data.results) ? {
                        results: hasResultChildren ? normalizedChildren.map((child, index) => ({
                            ...data.results[index],
                            agent: child.agent,
                            status: child.status,
                            summary: child.summary,
                            index: child.index,
                            artifactPath: child.artifactPath,
                            sessionPath: child.sessionPath,
                            children: child.children,
                        })) : [],
                    } : {}),
                });
            }
            catch (error) {
                console.error(`Completion observer failed for '${resultPath}':`, error);
            }
            if (!observerSucceeded) {
                scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                return;
            }
            if (!ownsCompletion(sessionId, completionOwnerId, epoch))
                return;
            if (!completionPersisted) {
                scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
                return;
            }
            removeDeliveredResult(file, triggerTurn, read);
        }
        catch (error) {
            if (isAccessDenied(error)) {
                console.error(`Failed to process subagent result file '${resultPath}'; will retry:`, error);
                scheduleResult(file, triggerTurn, RETRY_DELAY_MS);
            }
            else if (!isNotFound(error))
                console.error(`Failed to process subagent result file '${resultPath}':`, error);
        }
        finally {
            processing.delete(file);
            if (rereadReplacedPayload)
                scheduleResult(file, triggerTurn);
        }
    };
    const resultFileCoalescer = createFileCoalescer((file) => {
        const triggerTurn = pendingTriggerTurn.get(file) !== false;
        pendingTriggerTurn.delete(file);
        const run = handleResult(file, triggerTurn);
        handling.add(run);
        void run.finally(() => handling.delete(run));
    }, deps.coalesceDelayMs ?? 50);
    state.resultFileCoalescer = resultFileCoalescer;
    const logScanStats = (stats) => {
        const elapsed = Date.now() - stats.startedAt;
        if (elapsed < SLOW_RESULT_SCAN_MS)
            return;
        const resultScanLogging = deps.resultScanLogging ?? "activity";
        if (resultScanLogging === "off")
            return;
        // A scan that inspected and scheduled nothing is a quiet no-op (e.g. the
        // healthy periodic rescan while no async runs are pending). Under
        // "activity", skip it so empty scans do not burn context tokens in the
        // session transcript.
        if (resultScanLogging === "activity" && stats.files === 0 && stats.scheduled === 0)
            return;
        console.error(`Subagent result scan inspected ${stats.files} indexed result file(s), scheduled ${stats.scheduled} in ${elapsed}ms (${resultsDir}).`);
    };
    const indexedResultCandidates = (observed) => {
        const files = new Set();
        for (const sessionId of [state.currentSessionId, ...claimedSessionIds()]) {
            if (!sessionId)
                continue;
            for (const file of resultCandidateFilesForSession(resultsDir, sessionId))
                files.add(file);
        }
        for (const runId of state.asyncJobs.keys())
            files.add(`${runId}.json`);
        for (const file of missionObserverResultCandidateFiles(resultsDir))
            files.add(file);
        for (const runId of observed)
            files.add(`${runId}.json`);
        return [...files];
    };
    const eligibleResultFiles = () => {
        const files = [];
        try {
            const stats = { files: 0, scheduled: 0, startedAt: Date.now() };
            const observed = observedRunIds();
            for (const file of indexedResultCandidates(observed)) {
                stats.files += 1;
                const signature = resultSignature(file, observed);
                if (!signature)
                    continue;
                if (!shouldProcessResult(file, observed, signature))
                    continue;
                stats.scheduled += 1;
                files.push(file);
            }
            logScanStats(stats);
        }
        catch (error) {
            if (!isNotFound(error))
                console.error(`Failed to scan subagent result index in '${resultsDir}':`, error);
        }
        return files;
    };
    const primeExistingResults = (options = {}) => {
        const triggerTurn = options.triggerTurn !== false;
        for (const file of eligibleResultFiles())
            scheduleResult(file, triggerTurn);
    };
    /** Hand every result that is already on disk to the notifier now, without coalescing or batch delays. */
    const deliverPendingResults = async () => {
        if (!deliveryActive)
            return;
        deliveringPending += 1;
        try {
            notifier.flush?.();
            for (const file of eligibleResultFiles()) {
                scheduleResult(file, true);
                resultFileCoalescer.flush(file);
            }
            await Promise.allSettled([...handling]);
        }
        finally {
            deliveringPending -= 1;
        }
    };
    const clearResultScan = () => {
        if (resultScanTimer)
            timers.clearInterval(resultScanTimer);
        resultScanTimer = null;
    };
    const useNativeWatcher = () => shouldUseNativeFsWatch("result-delivery", deps.platform);
    const hasDeliveryDemand = () => {
        try {
            return deps.hasDeliveryDemand?.() === true;
        }
        catch (error) {
            console.error("Failed to inspect subagent result delivery demand:", error);
            return false;
        }
    };
    const clearResultPoller = () => {
        if (!state.watcherRestartTimer)
            return;
        timers.clearTimeout(state.watcherRestartTimer);
        timers.clearInterval(state.watcherRestartTimer);
        state.watcherRestartTimer = null;
    };
    const startDemandPolling = () => {
        if (!deliveryActive || useNativeWatcher() || state.watcherRestartTimer)
            return;
        if (!hasDeliveryDemand())
            return;
        state.watcherRestartTimer = timers.setInterval(() => {
            primeExistingResults();
            if (!hasDeliveryDemand())
                clearResultPoller();
        }, POLL_INTERVAL_MS);
        state.watcherRestartTimer.unref?.();
    };
    const startPolling = (reason) => {
        state.watcher?.close();
        state.watcher = null;
        clearResultScan();
        if (state.watcherRestartTimer)
            return;
        console.error(`Subagent result watcher for '${resultsDir}' fell back to polling because native fs.watch is unavailable (${errorCode(reason) ?? "unknown error"}).`);
        primeExistingResults();
        state.watcherRestartTimer = timers.setInterval(primeExistingResults, POLL_INTERVAL_MS);
        state.watcherRestartTimer.unref?.();
    };
    const scheduleRestart = () => {
        clearResultScan();
        if (state.watcherRestartTimer)
            return;
        state.watcherRestartTimer = timers.setTimeout(() => {
            state.watcherRestartTimer = null;
            try {
                fsApi.mkdirSync(resultsDir, { recursive: true });
                startResultWatcher();
            }
            catch (error) {
                if (shouldPoll(error))
                    return startPolling(error);
                console.error(`Failed to restart subagent result watcher for '${resultsDir}':`, error);
                scheduleRestart();
            }
        }, WATCHER_RESTART_DELAY_MS);
        state.watcherRestartTimer.unref?.();
    };
    const startResultWatcher = () => {
        if (state.watcher)
            return;
        activeSessionId = state.currentSessionId;
        deliveryActive = true;
        deliveryEpoch += 1;
        if (state.watcherRestartTimer) {
            timers.clearTimeout(state.watcherRestartTimer);
            timers.clearInterval(state.watcherRestartTimer);
            state.watcherRestartTimer = null;
        }
        if (!useNativeWatcher()) {
            startDemandPolling();
            return;
        }
        try {
            const watchDir = resolveWatchPath(resultsDir, fsApi.realpathSync.native);
            state.watcher = fsApi.watch(watchDir, (_event, file) => {
                if (!file) {
                    primeExistingResults();
                    return;
                }
                const fileName = file.toString();
                if (fileName.endsWith(".json")) {
                    identityCache.delete(fileName);
                    try {
                        writeResultIndexForData(path.join(resultsDir, fileName), JSON.parse(fsApi.readFileSync(path.join(resultsDir, fileName), "utf-8")));
                    }
                    catch {
                        // The writer may still be renaming the file; handleResult will retry from the normal result path.
                    }
                    scheduleResult(fileName, true);
                }
            });
            state.watcher.on("error", (error) => {
                if (shouldPoll(error))
                    return startPolling(error);
                console.error(`Subagent result watcher failed for '${resultsDir}':`, error);
                state.watcher?.close();
                state.watcher = null;
                scheduleRestart();
            });
            state.watcher.unref?.();
            resultScanTimer = timers.setInterval(primeExistingResults, HEALTHY_SCAN_INTERVAL_MS);
            resultScanTimer.unref?.();
        }
        catch (error) {
            if (shouldPoll(error))
                return startPolling(error);
            console.error(`Failed to start subagent result watcher for '${resultsDir}':`, error);
            state.watcher = null;
            scheduleRestart();
        }
    };
    const transitionResultDelivery = () => {
        deliveryActive = true;
        activeSessionId = state.currentSessionId;
        deliveryEpoch += 1;
        identityCache.clear();
    };
    const stopResultWatcher = () => {
        deliveryActive = false;
        activeSessionId = null;
        deliveryEpoch += 1;
        state.watcher?.close();
        state.watcher = null;
        clearResultPoller();
        clearResultScan();
        state.resultFileCoalescer.clear();
        pendingTriggerTurn.clear();
        processing.clear();
        identityCache.clear();
    };
    return { startResultWatcher, transitionResultDelivery, primeExistingResults, deliverPendingResults, stopResultWatcher, refreshResultDelivery: () => { primeExistingResults(); startDemandPolling(); } };
}
//# sourceMappingURL=result-watcher.js.map