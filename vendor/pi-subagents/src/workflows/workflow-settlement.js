import { workflowChildSummary } from "./workflow-child-summary.js";
export const UNSUPPORTED_DETACHED_WORKFLOW_CONTINUATION = "unsupported-continuation: detached workflow child settled, but JavaScript workflow continuation was not persisted. Resume the workflow explicitly instead of treating the completed child as top-level workflow completion.";
export const INTERRUPTED_DETACHED_CHILD = "Interrupted. Waiting for explicit next action.";
export const EVIDENCE_PERSISTENCE_FAILED = "evidence-persistence-failed";
function cloneWorkflowStatus(status) {
    return {
        ...status,
        steps: status.steps?.map((step) => ({ ...step })),
        workflow: status.workflow ? { ...status.workflow, trace: [...(status.workflow.trace ?? [])] } : status.workflow,
    };
}
function workflowState(status) {
    return status.state === "complete" ? "completed" : status.state === "paused" ? "paused" : status.state === "stopped" ? "stopped" : "failed";
}
function withWorkflowChildren(status) {
    return {
        ...status,
        workflowChildren: workflowChildSummary({
            parentToolCallId: status.toolCallId ?? status.runId,
            workflowRunId: status.runId,
            workflowState: workflowState(status),
            inventoryComplete: true,
            trace: status.workflow?.trace,
            steps: status.steps,
        }),
    };
}
export function findWorkflowSettlementStep(status, childRunId, workflowKey, sessionFile) {
    const exact = status.steps?.find((candidate) => candidate.runId === childRunId);
    if (exact || !workflowKey || !sessionFile)
        return exact;
    const candidates = status.steps?.filter((candidate) => candidate.runId === undefined
        && candidate.workflowKey === workflowKey
        && candidate.sessionFile === sessionFile) ?? [];
    return candidates.length === 1 ? candidates[0] : undefined;
}
export function promoteSettledPausedWorkflow(status, now = Date.now()) {
    if (status.mode !== "workflow" || status.state !== "paused")
        return undefined;
    const next = cloneWorkflowStatus(status);
    const stillOpen = next.steps?.some((candidate) => candidate.status === "running"
        || (candidate.status === "paused" && candidate.activityState === "needs_attention")) === true;
    if (stillOpen || !next.steps?.length)
        return undefined;
    const failed = next.steps.some((candidate) => candidate.status === "failed");
    next.lastUpdate = now;
    next.state = "failed";
    next.endedAt = now;
    delete next.activityState;
    if (!failed)
        next.error = UNSUPPORTED_DETACHED_WORKFLOW_CONTINUATION;
    return withWorkflowChildren(next);
}
export function applyDetachedChildSettlement(status, input) {
    if (status.mode !== "workflow" || status.state !== "paused")
        return undefined;
    const next = cloneWorkflowStatus(status);
    const step = findWorkflowSettlementStep(next, input.childRunId, input.workflowKey, input.result.sessionFile);
    if (!step)
        return undefined;
    step.runId ??= input.childRunId;
    const succeeded = input.result.exitCode === 0 && !input.result.error && !input.result.interrupted;
    const failedSiblingError = next.steps?.find((candidate) => {
        const candidateStep = candidate;
        return candidateStep !== step && candidateStep.status === "failed" && !candidateStep.interrupted && candidateStep.error;
    })?.error;
    const interruptedChildError = next.steps?.find((candidate) => {
        const candidateStep = candidate;
        return candidateStep.status === "failed" && candidateStep.interrupted && candidateStep.error;
    })?.error;
    const now = input.now ?? Date.now();
    step.status = succeeded ? "completed" : "failed";
    step.endedAt = now;
    delete step.activityState;
    delete step.currentTool;
    delete step.currentToolStartedAt;
    if (input.result.sessionFile)
        step.sessionFile = input.result.sessionFile;
    if (input.result.sessionName)
        step.sessionName = input.result.sessionName;
    if (succeeded) {
        delete step.error;
        delete step.interrupted;
    }
    else if (input.result.interrupted || input.result.stopped) {
        step.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
        step.interrupted = true;
        if (input.result.stopped)
            step.stopped = true;
    }
    else {
        delete step.interrupted;
        delete step.stopped;
        if (input.result.error)
            step.error = input.result.error;
    }
    next.lastUpdate = now;
    const promoted = promoteSettledPausedWorkflow(next, now);
    if (promoted?.state === "failed" && failedSiblingError)
        promoted.error = failedSiblingError;
    else if (promoted?.state === "failed" && (input.result.interrupted || input.result.stopped))
        promoted.error = input.result.error ?? INTERRUPTED_DETACHED_CHILD;
    else if (promoted?.state === "failed" && input.result.error)
        promoted.error = input.result.error;
    else if (promoted?.state === "failed" && interruptedChildError)
        promoted.error = interruptedChildError;
    return withWorkflowChildren(promoted ?? next);
}
export function classifyWorkflowSettlement(status, interrupted = false) {
    if (status.state !== "complete" && status.state !== "failed")
        return undefined;
    if (status.steps?.some((step) => {
        const candidate = step;
        return candidate.status === "failed" && !candidate.interrupted;
    }))
        return "failed-child";
    if (interrupted || status.steps?.some((step) => {
        const candidate = step;
        return candidate.status === "stopped" || candidate.stopped || candidate.interrupted || candidate.error === INTERRUPTED_DETACHED_CHILD;
    }))
        return "interrupted-child";
    return "settled-awaiting-resume";
}
export function workflowRecoveryActions(receipt) {
    if (!receipt)
        return [];
    return Object.values(receipt.entries).flatMap((entry) => entry.resumability.state === "resumable"
        ? [{ key: entry.key, call: "runs.run", resume: { workflowRunId: receipt.workflowRunId, key: entry.key, latest: true }, taskRequired: true }]
        : []);
}
export function workflowTerminalOutcomeForResult(result) {
    if (result.timedOut)
        return { state: "partial", reason: "timeout" };
    if (result.turnBudgetExceeded || result.toolBudgetBlocked)
        return { state: "partial", reason: "budget_exhausted" };
    return undefined;
}
export function workflowOutputPathMappingSummary(children) {
    const mappings = children.flatMap((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return [];
        const child = entry;
        return child.outputPathMapping
            ? [`'${child.workflowKey ?? "child"}': requested ${child.outputPathMapping.requestedPath} -> saved ${child.outputPathMapping.savedPath}`]
            : [];
    });
    return mappings.length > 0 ? ` Output path mappings: ${mappings.join("; ")}.` : "";
}
export function planWorkflowSettlement(input) {
    const now = input.now ?? Date.now();
    let status = withWorkflowChildren(cloneWorkflowStatus(input.status));
    let summary = input.summary;
    let receipt = input.receipt;
    let resolution = input.resolution;
    if (input.receiptPersistenceError) {
        const diagnostic = `${EVIDENCE_PERSISTENCE_FAILED}: ${input.receiptPersistenceError}`;
        status = withWorkflowChildren({ ...status, state: "failed", error: diagnostic, activityState: undefined, endedAt: now, lastUpdate: now });
        summary = `${diagnostic} Available child evidence was preserved, but workflow completion was not accepted.`;
        receipt = undefined;
        if (!resolution)
            resolution = classifyWorkflowSettlement(status);
    }
    const recovery = workflowRecoveryActions(receipt);
    delete status.workflowReceiptPath;
    if (receipt && input.receiptPath)
        status.workflowReceiptPath = input.receiptPath;
    if (receipt) {
        receipt = {
            ...receipt,
            state: status.state === "complete" ? "complete" : status.state === "paused" ? "paused" : status.state === "stopped" ? "stopped" : "failed",
            workflowChildren: status.workflowChildren,
            ...(resolution ? { workflowResolution: resolution, recovery } : {}),
        };
    }
    const publicResult = {
        ...input.baseResult,
        success: status.state === "complete",
        state: status.state,
        summary,
        error: status.state === "complete" ? undefined : status.error ?? summary,
        stopped: status.stopped ? true : undefined,
        activityState: status.activityState,
        workflowChildren: status.workflowChildren,
        results: input.children,
        ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
        ...(resolution ? { workflowResolution: resolution, recovery } : {}),
        ...(receipt && input.receiptPath ? { workflowReceipt: { path: input.receiptPath, receipt } } : {}),
        timestamp: now,
    };
    const terminal = status.state === "complete" || status.state === "failed" || status.state === "partial" || status.state === "stopped";
    if (!status.workflowReceiptPath)
        delete publicResult.workflowReceipt;
    const completionEvent = terminal ? {
        type: "subagent.workflow.completed",
        state: status.state,
        ...(resolution ? { workflowResolution: resolution } : {}),
        ...(input.terminalOutcome ? { terminalOutcome: input.terminalOutcome } : {}),
        ...(status.error ? { error: status.error } : {}),
        ...(status.activityState ? { activityState: status.activityState } : {}),
        ...input.eventMetadata,
    } : undefined;
    return { status, publicResult, receipt, recovery, completionEvent };
}
//# sourceMappingURL=workflow-settlement.js.map