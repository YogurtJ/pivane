import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { getSingleResultOutput, readStatus } from "../../shared/utils.js";
import { DIRS, SUBAGENT_ASYNC_COMPLETE_EVENT, } from "../../shared/types.js";
import { updateActiveRunIndex } from "../background/active-run-index.js";
import { resultFilePath, writeAsyncResultFile } from "../background/result-files.js";
import { resolveAsyncResumeTarget } from "../background/async-resume.js";
import { externalCliReceiptMetadata, normalizeExternalCliRunnerStatus } from "../shared/external-cli-contract.js";
import { outputPathMappingFromTask } from "../shared/single-output.js";
import { readWorkflowReceipt, workflowReceiptPath, writeWorkflowReceipt } from "../../workflows/workflow-receipt.js";
import { applyDetachedChildSettlement, classifyWorkflowSettlement, findWorkflowSettlementStep, planWorkflowSettlement, promoteSettledPausedWorkflow, workflowOutputPathMappingSummary, workflowRecoveryActions, workflowTerminalOutcomeForResult, } from "../../workflows/workflow-settlement.js";
export function applyDetachedChildToPausedWorkflow(status, input) {
    return applyDetachedChildSettlement(status, input);
}
export function promotePausedWorkflowIfSettled(status) {
    return promoteSettledPausedWorkflow(status);
}
function usageWithValue(usage) {
    return usage && (usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0)
        ? usage
        : undefined;
}
function workflowResultChildren(status, childRunId, result, existingResults, receipt) {
    const output = getSingleResultOutput(result);
    const outputReference = result.savedOutputPath ?? result.outputReference?.path;
    const outputPathMapping = outputPathMappingFromTask(result.task, outputReference);
    const terminalOutcome = workflowTerminalOutcomeForResult(result);
    const usage = usageWithValue(result.usage);
    if (Array.isArray(existingResults)) {
        return existingResults.map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry))
                return entry;
            const child = entry;
            if (child.runId !== childRunId)
                return child;
            return {
                ...child,
                success: result.exitCode === 0 && !result.error && !result.interrupted,
                output,
                outputState: output.trim() ? "present" : "absent",
                detached: undefined,
                ...(usage ? { usage } : {}),
                ...(outputReference ? { outputReference } : {}),
                ...(outputPathMapping ? { outputPathMapping } : {}),
                ...(result.interrupted || result.stopped ? { interrupted: true } : {}),
                ...(result.stopped ? { stopped: true } : {}),
                ...(terminalOutcome ? { terminalOutcome } : {}),
                ...(result.sessionName ? { sessionName: result.sessionName } : {}),
                ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
                ...(result.error ? { error: result.error } : {}),
            };
        });
    }
    return status.steps?.map((step) => ({
        workflowKey: step.workflowKey,
        agent: step.agent,
        ...(step.sessionName ? { sessionName: step.sessionName } : {}),
        runId: step.runId,
        success: step.status === "completed" || step.status === "complete",
        output: step.runId === childRunId ? output : "",
        outputState: step.runId === childRunId && output.trim() ? "present" : "absent",
        ...(step.runId === childRunId ? { ...(usage ? { usage } : {}), ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}) } : {}),
        ...(step.runId === childRunId && outputReference ? { outputReference } : step.workflowKey && receipt?.entries[step.workflowKey]?.outputReference ? { outputReference: receipt.entries[step.workflowKey].outputReference } : {}),
        ...(step.runId === childRunId && outputPathMapping ? { outputPathMapping } : step.outputPathMapping ? { outputPathMapping: step.outputPathMapping } : {}),
        ...(step.interrupted ? { interrupted: true } : {}),
        ...(step.runId === childRunId && terminalOutcome ? { terminalOutcome } : step.workflowKey && receipt?.entries[step.workflowKey]?.terminalOutcome ? { terminalOutcome: receipt.entries[step.workflowKey].terminalOutcome } : {}),
        ...(step.stopped ? { stopped: true } : {}),
        ...(step.error ? { error: step.error } : {}),
    }));
}
function reconcileWorkflowReceipt(status, childRunId, result, asyncDir, resolution) {
    const receiptRoot = path.dirname(asyncDir);
    const receiptPath = workflowReceiptPath(receiptRoot, status.runId);
    if (!fs.existsSync(receiptPath))
        return undefined;
    const receipt = readWorkflowReceipt(receiptRoot, status.runId);
    const step = status.steps?.find((candidate) => candidate.runId === childRunId);
    const key = step?.workflowKey;
    if (!key)
        throw new Error(`Workflow receipt '${status.runId}' cannot identify detached child '${childRunId}' by stable key.`);
    const entry = receipt.entries[key];
    if (!entry)
        throw new Error(`Workflow receipt '${status.runId}' has no detached child key '${key}'.`);
    let resumability;
    try {
        const target = resolveAsyncResumeTarget({ id: childRunId, dir: path.join(DIRS.async, childRunId) }, {}, { requireSessionFile: true, sessionId: status.sessionId });
        resumability = target.kind === "revive" ? { state: "resumable" } : { state: "not-resumable", reason: "child is still running" };
    }
    catch (error) {
        resumability = { state: "not-resumable", reason: error instanceof Error ? error.message : String(error) };
    }
    const outputReference = result.savedOutputPath ?? result.outputReference?.path ?? entry.outputReference;
    const childStatus = readStatus(path.join(DIRS.async, childRunId));
    const externalStep = childStatus?.steps?.length === 1 && childStatus.steps[0]?.runner?.type === "external-cli" ? childStatus.steps[0] : undefined;
    const externalRunner = normalizeExternalCliRunnerStatus(result.runner?.type === "external-cli" ? result.runner : externalStep?.runner);
    const externalProcess = result.externalProcess ?? externalStep?.externalProcess;
    const externalAdapter = externalRunner ? externalCliReceiptMetadata({ runner: externalRunner, externalProcess, outputReference }) : entry.externalAdapter;
    const childTerminalOutcome = workflowTerminalOutcomeForResult(result) ?? entry.terminalOutcome;
    if (externalAdapter)
        resumability = { state: "not-resumable", reason: externalAdapter.nonResumableReason };
    const updatedEntry = resumability.state === "resumable"
        ? {
            ...entry,
            ...(step.agent ? { agent: step.agent } : {}),
            ...(step.context ? { resolvedContext: step.context } : {}),
            latestRunId: entry.latestRunId ?? childRunId,
            resumability,
            ...(outputReference ? { outputReference } : {}),
            ...(childTerminalOutcome ? { terminalOutcome: childTerminalOutcome } : {}),
            ...(externalAdapter ? { externalAdapter } : {}),
        }
        : {
            ...entry,
            ...(step.agent ? { agent: step.agent } : {}),
            ...(step.context ? { resolvedContext: step.context } : {}),
            resumability,
            ...(outputReference ? { outputReference } : {}),
            ...(childTerminalOutcome ? { terminalOutcome: childTerminalOutcome } : {}),
            ...(externalAdapter ? { externalAdapter } : {}),
        };
    const next = {
        ...receipt,
        state: status.state === "complete" ? "complete" : status.state === "stopped" ? "stopped" : status.state === "paused" ? "paused" : "failed",
        entries: {
            ...receipt.entries,
            [key]: updatedEntry,
        },
        workflowChildren: status.workflowChildren,
        ...(receipt.terminalOutcome ? { terminalOutcome: receipt.terminalOutcome } : {}),
        ...(resolution ? { workflowResolution: resolution } : {}),
    };
    if (resolution)
        next.recovery = workflowRecoveryActions(next);
    else {
        delete next.workflowResolution;
        delete next.recovery;
    }
    return { receipt: next, path: writeWorkflowReceipt(asyncDir, next) };
}
function appendDetachedWorkflowEvent(asyncDir, event) {
    const eventsPath = path.join(asyncDir, "events.jsonl");
    try {
        fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
    }
    catch (error) {
        console.error(`Failed to append detached workflow event '${eventsPath}':`, error);
    }
}
export function reconcileDetachedWorkflowChildCompletion(input) {
    const job = input.state.asyncJobs.get(input.workflowRunId);
    const asyncDir = job?.asyncDir ?? path.join(DIRS.async, input.workflowRunId);
    const status = readStatus(asyncDir);
    if (!status)
        return false;
    const matchingControls = input.workflowKey === undefined ? [] : [...(input.state.foregroundControls?.values() ?? [])].filter((control) => control.parentWorkflowRunId === input.workflowRunId && control.workflowKey === input.workflowKey);
    const confirmedLiveIdentity = matchingControls.length === 1 && matchingControls[0]?.runId === input.childRunId;
    if (confirmedLiveIdentity) {
        const candidates = status.steps?.filter((candidate) => candidate.workflowKey === input.workflowKey) ?? [];
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        if (candidate && candidate.runId === undefined && candidate.sessionFile === undefined
            && candidate.status === "paused" && candidate.activityState === "needs_attention")
            candidate.runId = input.childRunId;
    }
    const next = applyDetachedChildToPausedWorkflow(status, {
        childRunId: input.childRunId,
        result: input.result,
        workflowKey: input.workflowKey,
    });
    if (!next)
        return false;
    const outputReference = input.result.savedOutputPath ?? input.result.outputReference?.path;
    const outputPathMapping = outputPathMappingFromTask(input.result.task, outputReference);
    const settledStep = findWorkflowSettlementStep(next, input.childRunId);
    if (settledStep && outputPathMapping)
        settledStep.outputPathMapping = outputPathMapping;
    const resultPath = resultFilePath(DIRS.results, input.workflowRunId);
    let existing;
    try {
        const parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
            existing = parsed;
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    let receipt;
    let receiptPath;
    let receiptError;
    const resolution = classifyWorkflowSettlement(next, input.result.interrupted);
    try {
        const publication = reconcileWorkflowReceipt(next, input.childRunId, input.result, asyncDir, resolution);
        receipt = publication?.receipt;
        receiptPath = publication?.path;
    }
    catch (error) {
        receiptError = `Failed to reconcile async workflow receipt: ${error instanceof Error ? error.message : String(error)}`;
    }
    const results = workflowResultChildren(next, input.childRunId, input.result, existing?.results, receipt);
    const recovery = workflowRecoveryActions(receipt);
    const summary = `${resolution === "settled-awaiting-resume"
        ? `Workflow lanes settled after detached child ${input.childRunId} finished. JavaScript workflow continuation was not persisted.${recovery.length ? " Use the listed keyed recovery action to continue a child." : " No retained child is resumable."}`
        : next.state === "complete"
            ? `Workflow completed after detached child ${input.childRunId} finished.`
            : next.error ?? (typeof existing?.summary === "string" ? existing.summary : "Workflow failed.")}${workflowOutputPathMappingSummary(results)}`;
    const plan = planWorkflowSettlement({
        status: next,
        summary,
        children: results,
        baseResult: {
            ...(existing ?? {}),
            id: next.runId,
            runId: next.runId,
            toolCallId: next.toolCallId,
            agent: "workflow",
            mode: "workflow",
            endedAt: next.endedAt,
            workflow: next.workflow,
            reconciledFromDetachedChild: input.childRunId,
            asyncDir,
            cwd: next.cwd,
            sessionId: next.sessionId ?? (typeof existing?.sessionId === "string" ? existing.sessionId : undefined),
            completionOwnerId: next.completionOwnerId,
            ...(next.scheduleOrigin ? { scheduleOrigin: next.scheduleOrigin } : {}),
        },
        receipt,
        receiptPath,
        receiptPersistenceError: receiptError,
        resolution,
        terminalOutcome: receipt?.terminalOutcome,
        eventMetadata: { reconciledFromDetachedChild: input.childRunId },
    });
    writeAtomicJson(path.join(asyncDir, "status.json"), plan.status);
    updateActiveRunIndex(asyncDir, plan.status.state, plan.status.toolCallId);
    if (job) {
        job.status = plan.status.state;
        job.updatedAt = plan.status.lastUpdate;
        job.activityState = plan.status.activityState;
        job.steps = plan.status.steps?.map((step, index) => ({ ...step, index }));
        job.workflow = plan.status.workflow;
    }
    writeAsyncResultFile(resultPath, plan.publicResult);
    if (receiptError) {
        appendDetachedWorkflowEvent(asyncDir, {
            ts: Date.now(),
            runId: input.workflowRunId,
            type: "subagent.workflow.receipt_write_failed",
            error: receiptError,
            reconciledFromDetachedChild: input.childRunId,
        });
    }
    if (plan.completionEvent) {
        appendDetachedWorkflowEvent(asyncDir, {
            ts: Date.now(),
            runId: input.workflowRunId,
            ...plan.completionEvent,
            recovery: plan.recovery,
        });
        input.events?.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
            id: input.workflowRunId,
            runId: input.workflowRunId,
            source: "async",
            mode: "workflow",
            agent: "workflow",
            success: plan.status.state === "complete",
            state: plan.status.state,
            ...(plan.publicResult.workflowReceipt ? { workflowReceipt: plan.publicResult.workflowReceipt } : {}),
            ...(resolution ? { workflowResolution: resolution } : {}),
            ...(plan.receipt?.terminalOutcome ? { terminalOutcome: plan.receipt.terminalOutcome } : {}),
            recovery: plan.recovery,
            summary: typeof plan.publicResult.summary === "string" ? plan.publicResult.summary : plan.status.error,
            reconciledFromDetachedChild: input.childRunId,
            results,
            sessionId: plan.status.sessionId,
            completionOwnerId: plan.status.completionOwnerId,
            ...(plan.status.scheduleOrigin ? { scheduleOrigin: plan.status.scheduleOrigin } : {}),
            timestamp: Date.now(),
            triggerTurn: true,
        });
    }
    return true;
}
//# sourceMappingURL=workflow-detach-reconcile.js.map