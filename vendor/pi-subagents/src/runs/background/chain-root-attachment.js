import * as fs from "node:fs";
import * as path from "node:path";
import { resultFilePath, resultPayloadPathForSessionRun } from "./result-files.js";
import { readStatus } from "../../shared/utils.js";
const TERMINAL_STATES = new Set(["complete", "failed", "partial", "paused", "stopped"]);
const TERMINAL_STEP_STATUSES = new Set(["complete", "completed", "failed", "partial", "paused", "stopped"]);
function readResultFile(resultPath) {
    try {
        return JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    }
    catch (error) {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
function readImportedResultFile(root, status) {
    const direct = readResultFile(root.resultPath);
    if (direct || !status?.sessionId)
        return direct;
    const indexedPath = resultPayloadPathForSessionRun(path.dirname(root.resultPath), status.sessionId, root.runId);
    return indexedPath ? readResultFile(indexedPath) : undefined;
}
function selectedStatusStep(status, index) {
    return status?.steps?.[index];
}
function isTerminalStatus(status, index) {
    if (!status)
        return false;
    // A workflow-owned single runner publishes its result after completing its
    // step. Keep that window open while root process proof is absent or pending;
    // explicit terminal/unavailable proof retains the existing step fallback.
    if (status.mode === "single" && status.parentWorkflowRunId
        && (!status.processTerminal || status.processTerminal.state === "pending"))
        return TERMINAL_STATES.has(status.state);
    const step = selectedStatusStep(status, index);
    if (step && TERMINAL_STEP_STATUSES.has(step.status))
        return true;
    return TERMINAL_STATES.has(status.state);
}
function resultState(result, child) {
    if (!result)
        return undefined;
    if (child?.stopped === true)
        return "stopped";
    if (child?.success === true)
        return "complete";
    if (child?.success === false)
        return result.state === "stopped" ? "stopped" : result.state === "paused" ? "paused" : result.state === "partial" ? "partial" : "failed";
    if (result.state === "complete" || result.state === "failed" || result.state === "partial" || result.state === "paused" || result.state === "stopped")
        return result.state;
    if (result.success === true)
        return "complete";
    if (result.success === false)
        return "failed";
    return undefined;
}
function outputFromTerminalStatus(root, status, step) {
    const agent = step?.agent ?? status.steps?.[root.index]?.agent ?? "subagent";
    const timedOut = step?.timedOut === true || status.timedOut === true;
    const stopped = step?.stopped === true || status.stopped === true || status.state === "stopped";
    const message = step?.error ?? status.error ?? (stopped ? "Subagent stopped by user." : `Attached async root ${root.runId} ended without a result file at ${root.resultPath}.`);
    const partialStatus = status.state === "partial" || step?.status === "partial";
    const execution = step?.execution ?? (partialStatus
        ? { status: "partial", success: false, exitCode: 1, error: message }
        : undefined);
    return {
        agent,
        output: message,
        success: false,
        exitCode: 1,
        error: message,
        ...(timedOut ? { timedOut: true } : {}),
        ...(stopped ? { stopped: true } : {}),
        ...(step?.sessionName ? { sessionName: step.sessionName } : {}),
        ...(step?.sessionFile ?? status.sessionFile ? { sessionFile: step?.sessionFile ?? status.sessionFile } : {}),
        ...(step?.model ? { model: step.model } : {}),
        ...(step?.requestedModel ? { requestedModel: step.requestedModel } : {}),
        ...(step?.contextOverflow ? { contextOverflow: true } : {}),
        ...(step?.totalCost ? { totalCost: step.totalCost } : {}),
        ...(step?.structuredOutput !== undefined ? { structuredOutput: step.structuredOutput } : {}),
        ...(step?.structuredOutputPath ? { structuredOutputPath: step.structuredOutputPath } : {}),
        ...(step?.structuredOutputSchemaPath ? { structuredOutputSchemaPath: step.structuredOutputSchemaPath } : {}),
        ...(step?.acceptance ? { acceptance: step.acceptance } : {}),
        ...(execution ? { execution } : {}),
        ...(step?.effects ? { effects: step.effects } : {}),
        ...(step?.transcriptPath ? { transcriptPath: step.transcriptPath } : {}),
    };
}
function outputFromTimeout(root, status, message) {
    const step = selectedStatusStep(status, root.index);
    return {
        agent: step?.agent ?? status?.steps?.[root.index]?.agent ?? "subagent",
        output: message,
        success: false,
        exitCode: 1,
        error: message,
        timedOut: true,
        ...(step?.sessionName ? { sessionName: step.sessionName } : {}),
        ...(step?.sessionFile ?? status?.sessionFile ? { sessionFile: step?.sessionFile ?? status?.sessionFile } : {}),
        ...(step?.model ? { model: step.model } : {}),
        ...(step?.requestedModel ? { requestedModel: step.requestedModel } : {}),
        ...(step?.contextOverflow ? { contextOverflow: true } : {}),
        ...(step?.totalCost ? { totalCost: step.totalCost } : {}),
        ...(step?.transcriptPath ? { transcriptPath: step.transcriptPath } : {}),
    };
}
function buildImportedResult(root, status, result) {
    const child = result.results?.[root.index];
    const step = selectedStatusStep(status, root.index);
    const state = resultState(result, child);
    const agent = child?.agent ?? step?.agent ?? status?.steps?.[root.index]?.agent ?? "subagent";
    const output = child?.output ?? result.summary ?? "";
    const timedOut = child?.timedOut === true || step?.timedOut === true || result.timedOut === true || status?.timedOut === true;
    const stopped = child?.stopped === true || step?.stopped === true || result.stopped === true || status?.stopped === true || state === "stopped";
    const success = state === "complete" && !timedOut && !stopped;
    const error = child?.error ?? (success ? undefined : stopped ? "Subagent stopped by user." : result.error ?? result.summary ?? status?.error ?? `Attached async root ${root.runId} did not complete successfully.`);
    const execution = state ? { status: state === "complete" ? "completed" : state, success, exitCode: success ? 0 : 1, ...(error ? { error } : {}) } : undefined;
    const usage = child?.usage;
    return {
        agent,
        importedPublication: {
            ...(typeof result.sessionId === "string" ? { sessionId: result.sessionId } : {}),
            ...(typeof result.toolCallId === "string" ? { toolCallId: result.toolCallId } : {}),
        },
        output: success ? output : (output || error || ""),
        success,
        exitCode: success ? 0 : 1,
        ...(error ? { error } : {}),
        ...(timedOut ? { timedOut: true } : {}),
        ...(stopped ? { stopped: true } : {}),
        ...(child?.sessionName ?? step?.sessionName ? { sessionName: child?.sessionName ?? step?.sessionName } : {}),
        ...(child?.sessionFile ?? step?.sessionFile ?? status?.sessionFile ? { sessionFile: child?.sessionFile ?? step?.sessionFile ?? status?.sessionFile } : {}),
        ...(child?.intercomTarget ? { intercomTarget: child.intercomTarget } : {}),
        ...(child?.model ?? step?.model ? { model: child?.model ?? step?.model } : {}),
        ...(child?.requestedModel ?? step?.requestedModel ? { requestedModel: child?.requestedModel ?? step?.requestedModel } : {}),
        ...(child?.contextOverflow || step?.contextOverflow ? { contextOverflow: true } : {}),
        ...(child?.totalCost ?? step?.totalCost ? { totalCost: child?.totalCost ?? step?.totalCost } : {}),
        ...(usage ? { usage } : {}),
        ...(child?.structuredOutput !== undefined ? { structuredOutput: child.structuredOutput } : step?.structuredOutput !== undefined ? { structuredOutput: step.structuredOutput } : {}),
        ...(child?.structuredOutputPath ?? step?.structuredOutputPath ? { structuredOutputPath: child?.structuredOutputPath ?? step?.structuredOutputPath } : {}),
        ...(child?.structuredOutputSchemaPath ?? step?.structuredOutputSchemaPath ? { structuredOutputSchemaPath: child?.structuredOutputSchemaPath ?? step?.structuredOutputSchemaPath } : {}),
        ...(child?.acceptance ?? step?.acceptance ? { acceptance: child?.acceptance ?? step?.acceptance } : {}),
        ...(child?.artifactPaths ? { artifactPaths: child.artifactPaths } : {}),
        ...(child?.savedOutputPath ? { savedOutputPath: child.savedOutputPath } : {}),
        ...(child?.outputSaveError ? { outputSaveError: child.outputSaveError } : {}),
        ...(child?.transcriptPath ?? step?.transcriptPath ? { transcriptPath: child?.transcriptPath ?? step?.transcriptPath } : {}),
        ...(child?.transcriptError ? { transcriptError: child.transcriptError } : {}),
        ...(execution ? { execution } : {}),
        ...(child?.effects ?? step?.effects ? { effects: child?.effects ?? step?.effects } : {}),
    };
}
export async function waitForImportedAsyncRoot(root, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 500;
    const terminalResultGraceMs = options.terminalResultGraceMs ?? 1_000;
    const now = options.now ?? Date.now;
    let terminalSince;
    for (;;) {
        const status = readStatus(root.asyncDir);
        if (options.shouldAbort?.())
            return outputFromTimeout(root, status, options.timeoutMessage ?? "Subagent timed out.");
        const result = readImportedResultFile(root, status);
        if (result)
            return buildImportedResult(root, status, result);
        if (isTerminalStatus(status, root.index)) {
            terminalSince ??= now();
            if (now() - terminalSince >= terminalResultGraceMs) {
                return outputFromTerminalStatus(root, status, selectedStatusStep(status, root.index));
            }
        }
        else {
            terminalSince = undefined;
        }
        if (!status && !fs.existsSync(root.asyncDir)) {
            throw new Error(`Attached async root '${root.runId}' directory does not exist: ${root.asyncDir}`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
}
export function resolveAsyncRootResultPath(resultsDir, runId) {
    return resultFilePath(resultsDir, runId);
}
//# sourceMappingURL=chain-root-attachment.js.map