import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { resultFilePath, resultPayloadPathForSessionRun, writeAsyncResultFile } from "./result-files.js";
import { updateActiveRunIndex } from "./active-run-index.js";
import { readProcessTerminal } from "./process-terminal.js";
import { readStatus } from "../../shared/utils.js";
import { DIRS } from "../../shared/types.js";
import { resolveEffectiveThinking } from "../../shared/model-info.js";
import { normalizeParallelGroups } from "./parallel-groups.js";
import { nestedSummaryFromAsyncStatus, projectNestedEvents, resolveNestedAsyncDir, writeNestedEvent } from "../shared/nested-events.js";
import { assertWorkflowGraphHostSteps } from "../shared/host-step-status.js";
import { currentPidNamespaceScope } from "./pid-namespace.js";
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function readRunnerStartupDiagnostics(asyncDir) {
    const stderrPath = path.join(asyncDir, "runner.stderr.log");
    const maxBytes = 64 * 1024;
    let content;
    try {
        const stat = fs.statSync(stderrPath);
        if (stat.size <= 0)
            return undefined;
        const fd = fs.openSync(stderrPath, "r");
        try {
            const bytesToRead = Math.min(stat.size, maxBytes);
            const start = Math.max(0, stat.size - bytesToRead);
            const buffer = Buffer.alloc(bytesToRead);
            fs.readSync(fd, buffer, 0, bytesToRead, start);
            content = buffer.toString("utf-8").trim();
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return undefined;
    }
    if (!content)
        return undefined;
    const lines = content.split(/\r?\n/).slice(-30).join("\n");
    return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}
function isNotFoundError(error) {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && error.code === "ENOENT";
}
function appendJsonlBestEffort(filePath, payload) {
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
    }
    catch {
        // Repair status/result writes are the important path. A broken or full
        // diagnostic event log must not make stale-run reconciliation fail.
    }
}
function regularFileExists(filePath) {
    try {
        return fs.statSync(filePath).isFile();
    }
    catch (error) {
        if (isNotFoundError(error))
            return false;
        throw error;
    }
}
function readResultRepairData(resultPath) {
    try {
        const data = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        if (data.error !== undefined && typeof data.error !== "string")
            throw new Error(`Invalid async result file '${resultPath}': error must be a string.`);
        const state = data.success ? "complete" : data.state === "stopped" ? "stopped" : data.state === "rejected" ? "rejected" : data.state === "partial" ? "partial" : data.state === "paused" || data.exitCode === 0 ? "paused" : "failed";
        const results = Array.isArray(data.results)
            ? data.results.map((entry, index) => {
                if (!entry || typeof entry !== "object" || Array.isArray(entry))
                    return {};
                const child = entry;
                if (child.model !== undefined && typeof child.model !== "string")
                    throw new Error(`Invalid async result file '${resultPath}': results[${index}].model must be a string.`);
                if (child.thinking !== undefined && typeof child.thinking !== "string")
                    throw new Error(`Invalid async result file '${resultPath}': results[${index}].thinking must be a string.`);
                return child;
            })
            : undefined;
        return { state, ...(data.error ? { error: data.error } : {}), ...(results ? { results } : {}) };
    }
    catch (error) {
        if (isNotFoundError(error))
            return undefined;
        throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
            cause: error instanceof Error ? error : undefined,
        });
    }
}
function childState(overallState, child) {
    if (child?.success === true)
        return "complete";
    if (child?.success === false)
        return "failed";
    return overallState;
}
function failureDiagnostic(value) {
    return typeof value === "string" && value.trim() ? value : undefined;
}
function terminalStatusFromResult(status, resultPath, now) {
    const repair = readResultRepairData(resultPath);
    if (!repair)
        return undefined;
    const rootError = failureDiagnostic(status.error)
        ?? failureDiagnostic(repair.error)
        ?? repair.results?.map((child) => child.success === false ? failureDiagnostic(child.error) : undefined).find(Boolean);
    const steps = (status.steps ?? []).map((step, index) => {
        if (step.status !== "running" && step.status !== "pending")
            return step;
        const child = repair.results?.[index];
        const state = childState(repair.state, child);
        const model = child?.model ?? step.model;
        const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
        return {
            ...step,
            status: state === "complete" ? "complete" : state,
            endedAt: step.endedAt ?? now,
            durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
            exitCode: step.exitCode ?? (state === "complete" || state === "paused" ? 0 : 1),
            error: state === "failed" || state === "partial" || state === "stopped" ? step.error ?? child?.error : step.error,
            stopped: state === "stopped" ? true : step.stopped,
            sessionName: step.sessionName ?? child?.sessionName,
            sessionFile: step.sessionFile ?? child?.sessionFile,
            model,
            thinking,
            requestedModel: child?.requestedModel ?? step.requestedModel,
            contextOverflow: child?.contextOverflow ?? step.contextOverflow,
        };
    });
    const terminalStatus = {
        ...status,
        state: repair.state,
        ...(rootError && (repair.state === "failed" || repair.state === "partial") ? { error: rootError } : {}),
        ...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
            processTerminal: { version: 1, state: "unknown", runId: status.runId, runnerProcessInstanceId: "observer-unavailable", reason: "observer-unavailable" },
        } : {}),
        ...(repair.state === "stopped" ? { stopped: true } : {}),
        activityState: undefined,
        lastUpdate: now,
        endedAt: status.endedAt ?? now,
        steps,
    };
    delete terminalStatus.displayDismissedAt;
    return terminalStatus;
}
function buildStartedStatus(asyncDir, startedRun, now) {
    const startedAt = startedRun.startedAt ?? now;
    const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
    const chainStepCount = startedRun.chainStepCount;
    const parallelGroups = chainStepCount !== undefined
        ? normalizeParallelGroups(startedRun.parallelGroups, agents.length, chainStepCount)
        : [];
    return {
        runId: startedRun.runId || path.basename(asyncDir),
        ...(startedRun.sessionId ? { sessionId: startedRun.sessionId } : {}),
        ...(startedRun.completionOwnerId ? { completionOwnerId: startedRun.completionOwnerId } : {}),
        mode: startedRun.mode ?? "single",
        state: "running",
        pid: startedRun.pid,
        pidNamespaceScope: currentPidNamespaceScope(),
        startedAt,
        lastUpdate: now,
        currentStep: 0,
        ...(chainStepCount !== undefined ? { chainStepCount } : {}),
        ...(parallelGroups.length ? { parallelGroups } : {}),
        steps: agents.map((agent) => ({
            agent,
            status: "running",
            startedAt,
        })),
        ...(startedRun.sessionFile ? { sessionFile: startedRun.sessionFile } : {}),
    };
}
function buildFailedRepair(status, asyncDir, now, reason) {
    const runId = status.runId || path.basename(asyncDir);
    const pid = typeof status.pid === "number" ? status.pid : "unknown";
    const terminal = readProcessTerminal(asyncDir, { runId }) ?? status.processTerminal;
    const runnerExit = terminal?.state === "observed" || terminal?.state === "unknown"
        ? terminal.instances?.find((instance) => instance.kind === "runner" && instance.processInstanceId === terminal.runnerProcessInstanceId)
        : undefined;
    const exitText = runnerExit?.kind === "runner"
        ? `exited with code ${runnerExit.exitCode ?? "none"}${runnerExit.signal ? ` (signal ${runnerExit.signal})` : ""}`
        : "exited or disappeared";
    const baseMessage = reason ?? `Async runner process ${pid} ${exitText} before writing a result. Marked run failed by stale-run reconciliation.`;
    const diagnostics = readRunnerStartupDiagnostics(asyncDir);
    const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
    const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" }];
    const repairedSteps = steps.map((step) => step.status === "running" || step.status === "pending"
        ? {
            ...step,
            status: "failed",
            activityState: undefined,
            endedAt: step.endedAt ?? now,
            durationMs: step.startedAt !== undefined && step.durationMs === undefined ? Math.max(0, now - step.startedAt) : step.durationMs,
            exitCode: step.exitCode ?? 1,
            error: step.error ?? message,
        }
        : step);
    const repairedStatus = {
        ...status,
        state: "failed",
        ...(status.lifecycleArtifactVersion === 3 && (!status.processTerminal || status.processTerminal.state === "pending") ? {
            processTerminal: { version: 1, state: "unknown", runId, runnerProcessInstanceId: "observer-unavailable", reason: "stale-repair" },
        } : {}),
        activityState: undefined,
        lastUpdate: now,
        endedAt: now,
        steps: repairedSteps,
    };
    const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
    return {
        status: repairedStatus,
        message,
        result: {
            id: runId,
            agent: resultAgent,
            mode: status.mode,
            ...(status.completionOwnerId ? { completionOwnerId: status.completionOwnerId } : {}),
            success: false,
            state: "failed",
            summary: message,
            results: repairedSteps.map((step) => ({
                agent: step.agent,
                ...(step.sessionName ? { sessionName: step.sessionName } : {}),
                output: step.status === "complete" || step.status === "completed" ? "" : message,
                error: step.status === "complete" || step.status === "completed" ? undefined : step.error ?? message,
                success: step.status === "complete" || step.status === "completed",
                model: step.model,
                requestedModel: step.requestedModel,
                contextOverflow: step.contextOverflow,
                sessionFile: step.sessionFile,
            })),
            exitCode: 1,
            timestamp: now,
            durationMs: Math.max(0, now - status.startedAt),
            asyncDir,
            sessionId: status.sessionId,
            sessionFile: status.sessionFile,
        },
    };
}
function writeFailedRepair(asyncDir, status, resultPath, now, reason) {
    const repair = buildFailedRepair(status, asyncDir, now, reason);
    if (repair.result.sessionId)
        writeAsyncResultFile(resultPath, repair.result);
    writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
    updateActiveRunIndex(asyncDir, repair.status.state, repair.status.toolCallId);
    appendJsonlBestEffort(path.join(asyncDir, "events.jsonl"), {
        type: "subagent.run.repaired_stale",
        ts: now,
        runId: repair.status.runId,
        pid: status.pid,
        ...(repair.result.sessionId ? { resultPath } : {}),
        message: repair.message,
    });
    return { status: repair.status, repaired: true, ...(repair.result.sessionId ? { resultPath } : {}), message: repair.message };
}
function terminal(state) {
    return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}
function* nestedRuns(children) {
    for (const child of children ?? []) {
        yield child;
        yield* nestedRuns(child.children);
        yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
    }
}
export function reconcileNestedAsyncDescendants(route, options = {}) {
    const registry = projectNestedEvents(route);
    for (const run of nestedRuns(registry.children)) {
        if (run.state !== "running" && run.state !== "queued")
            continue;
        const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
        if (!asyncDir)
            continue;
        const result = reconcileAsyncRun(asyncDir, {
            ...options,
            resultsDir: path.join(options.resultsDir ?? DIRS.results, "nested", route.rootRunId),
        });
        const status = result.status;
        if (!status)
            continue;
        if (!result.repaired && !terminal(status.state))
            continue;
        const ts = options.now?.() ?? Date.now();
        writeNestedEvent(route, {
            type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
            ts,
            parentRunId: run.parentRunId,
            parentStepIndex: run.parentStepIndex,
            child: nestedSummaryFromAsyncStatus(status, asyncDir, {
                id: run.id,
                parentRunId: run.parentRunId,
                parentStepIndex: run.parentStepIndex,
                depth: run.depth,
                path: run.path,
                mode: run.mode,
                ts,
            }),
        });
    }
}
export function checkPidLiveness(pid, kill = process.kill) {
    try {
        kill(pid, 0);
        return "alive";
    }
    catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "ESRCH")
            return "dead";
        if (code === "EPERM")
            return "unknown";
        return "unknown";
    }
}
export function reconcileAsyncRun(asyncDir, options = {}, observeStatus) {
    const now = options.now?.() ?? Date.now();
    const status = readStatus(asyncDir);
    observeStatus?.(status);
    const startedStatus = !status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
    const effectiveStatus = status ?? startedStatus;
    if (!effectiveStatus)
        return { status: null, repaired: false };
    assertWorkflowGraphHostSteps(effectiveStatus.workflowGraph, path.join(asyncDir, "status.json"), effectiveStatus.runId);
    const statusPath = path.join(asyncDir, "status.json");
    for (const [index, step] of (effectiveStatus.steps ?? []).entries()) {
        const stepRecord = step;
        if (stepRecord.model !== undefined && typeof stepRecord.model !== "string")
            throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
        if (stepRecord.thinking !== undefined && typeof stepRecord.thinking !== "string")
            throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
    }
    const runId = effectiveStatus.runId || path.basename(asyncDir);
    const resultsDir = options.resultsDir ?? DIRS.results;
    const resultPath = resultFilePath(resultsDir, runId);
    const existingResultPath = effectiveStatus.sessionId
        ? resultPayloadPathForSessionRun(resultsDir, effectiveStatus.sessionId, runId) ?? (regularFileExists(resultPath) ? resultPath : undefined)
        : regularFileExists(resultPath) ? resultPath : undefined;
    if (existingResultPath) {
        const terminalStatus = effectiveStatus.state === "running" || effectiveStatus.state === "queued"
            ? terminalStatusFromResult(effectiveStatus, existingResultPath, now)
            : undefined;
        if (terminalStatus) {
            const currentStatus = readStatus(asyncDir);
            const currentRootError = failureDiagnostic(currentStatus?.error);
            const currentTerminal = currentStatus?.processTerminal?.state === "observed" || currentStatus?.processTerminal?.state === "unknown"
                ? currentStatus.processTerminal
                : undefined;
            const steps = terminalStatus.steps?.map((step, index) => {
                const currentStepTerminal = currentStatus?.steps?.[index]?.processTerminal;
                return currentStepTerminal?.state === "observed" || currentStepTerminal?.state === "unknown"
                    ? { ...step, processTerminal: currentStepTerminal }
                    : step;
            });
            const statusToWrite = {
                ...terminalStatus,
                ...(currentRootError ? { error: currentRootError } : {}),
                ...(currentTerminal ? { processTerminal: currentTerminal } : {}),
                ...(steps ? { steps } : {}),
            };
            writeAtomicJson(statusPath, statusToWrite);
            updateActiveRunIndex(asyncDir, statusToWrite.state, statusToWrite.toolCallId);
            return { status: statusToWrite, repaired: true, resultPath: existingResultPath, message: "Existing async result file was used to repair stale running status." };
        }
        if (effectiveStatus.displayDismissedAt === undefined)
            return { status: effectiveStatus, repaired: false, resultPath: existingResultPath };
    }
    if (effectiveStatus.displayDismissedAt !== undefined) {
        return { status: null, repaired: false, resultPath };
    }
    if (effectiveStatus.state !== "running" || typeof effectiveStatus.pid !== "number") {
        return { status: status ?? null, repaired: false, resultPath };
    }
    if (!status) {
        const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
        if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) {
            return { status: null, repaired: false, resultPath };
        }
    }
    const observedScope = options.pidNamespaceScope ? options.pidNamespaceScope() : currentPidNamespaceScope();
    // An observer without a scope (macOS/Windows host sharing a container's temp root) cannot match a recorded one.
    const pidScopeMismatch = effectiveStatus.pidNamespaceScope !== undefined && effectiveStatus.pidNamespaceScope !== observedScope;
    const observedLiveness = checkPidLiveness(effectiveStatus.pid, options.kill);
    const liveness = observedLiveness === "dead" && pidScopeMismatch ? "unknown" : observedLiveness;
    if (liveness !== "dead") {
        const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
        const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
        if (now - lastUpdate <= staleAfterMs)
            return { status: status ?? null, repaired: false, resultPath };
        const probe = liveness === "alive" ? "is still live" : "cannot be probed from this process";
        const message = `Async runner PID ${effectiveStatus.pid} ${probe}; status has not updated for ${now - lastUpdate}ms, so stale-run reconciliation marked the run failed because PID ownership is unverified.`;
        return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now, message);
    }
    return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
//# sourceMappingURL=stale-run-reconciler.js.map