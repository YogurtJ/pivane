import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "../../shared/utils.js";
import { readProcessTerminal } from "./process-terminal.js";
const TERMINAL_WORKFLOW_STATES = new Set(["completed", "failed", "stopped"]);
export function isTerminalAsyncState(state) {
    return state !== "queued" && state !== "running" && state !== "paused";
}
/**
 * The model an async workflow child reports for itself. Workflow lane records keep only
 * launch identity, so display projections fall back to the child's own status step.
 */
export function readWorkflowChildRunModel(workflowAsyncDir, step) {
    if (step.async !== true || typeof step.runId !== "string" || path.basename(step.runId) !== step.runId)
        return undefined;
    try {
        const child = readStatus(path.join(path.dirname(workflowAsyncDir), step.runId));
        const first = Array.isArray(child?.steps) ? child.steps[0] : undefined;
        const model = typeof first?.model === "string" && first.model ? first.model : undefined;
        const thinking = typeof first?.thinking === "string" && first.thinking ? first.thinking : undefined;
        return model || thinking ? { model, thinking } : undefined;
    }
    catch {
        return undefined;
    }
}
/** Fill a workflow child roster row from the child's own reported model. */
export function withWorkflowChildRunModel(workflowAsyncDir, child) {
    if (child.model && child.thinking)
        return child;
    const reported = readWorkflowChildRunModel(workflowAsyncDir, { async: true, runId: child.runId });
    const model = child.model ?? reported?.model;
    const thinking = child.thinking ?? reported?.thinking;
    return { ...child, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
}
/**
 * Process evidence for a workflow's async children. Status proofs and capacity
 * release both use this so they cannot disagree about the same workflow.
 */
export function readWorkflowChildProcessEvidence(workflowAsyncDir, steps) {
    if (!steps)
        return { state: "unknown", reason: "workflow child roster is missing" };
    const children = [];
    for (const step of steps) {
        const child = readWorkflowChildEvidence(workflowAsyncDir, step);
        if (!child)
            continue;
        if (child.state !== "resolved")
            return { state: child.state, reason: child.reason };
        children.push(child.proof);
    }
    return { state: "observed", children };
}
/**
 * The host records an async child's run id before launching it, so a launch that fails before any runner
 * exists leaves a failed roster step whose run directory has no status and no runner artifacts.
 */
function launchFailedBeforeRunner(step, childDir) {
    if (step.status !== "failed" || !step.error)
        return false;
    return !childDir || !["process-terminal.json", "runner-startup.json"].some((file) => fs.existsSync(path.join(childDir, file)));
}
/** Evidence for one roster entry; undefined for synchronous children, which run inside the workflow host and have no process of their own, and for async children whose launch failed before a runner existed. */
export function readWorkflowChildEvidence(workflowAsyncDir, step) {
    const label = step.workflowKey ?? step.agent;
    if (typeof step.async !== "boolean")
        return { state: "unknown", reason: `workflow child ${label} is missing async classification` };
    if (!step.async)
        return undefined;
    if (!step.runId || path.basename(step.runId) !== step.runId)
        return { state: "unknown", reason: `async workflow child ${label} is missing run id` };
    const childDir = path.join(path.dirname(workflowAsyncDir), step.runId);
    if (!fs.existsSync(childDir))
        return launchFailedBeforeRunner(step) ? undefined : { state: "unknown", reason: `async workflow child ${label} directory is missing` };
    const childStatus = readStatus(childDir);
    if (!childStatus)
        return launchFailedBeforeRunner(step, childDir) ? undefined : { state: "unknown", reason: `async workflow child ${label} status is missing or unreadable` };
    if (!isTerminalAsyncState(childStatus.state))
        return { state: "pending", reason: `async workflow child ${label} is still ${childStatus.state}` };
    const recorded = childStatus.processTerminal;
    if (!recorded?.runnerProcessInstanceId)
        return { state: "unknown", reason: `async workflow child ${label} has no runner process identity` };
    // A runner startup failure records `not-started` in status and never writes a process-terminal sidecar.
    if (recorded.state === "not-started" && recorded.runId === step.runId && typeof childStatus.error === "string" && childStatus.error) {
        return { state: "resolved", proof: recorded };
    }
    const proof = readProcessTerminal(childDir, { runId: step.runId, runnerProcessInstanceId: recorded.runnerProcessInstanceId });
    if (proof?.state !== "observed" || proof.runId !== step.runId) {
        const proofState = proof?.state ?? "missing";
        const bound = childStatus.runId === step.runId && typeof recorded.runnerProcessInstanceId === "string";
        return {
            state: !proof || proof.state === "pending" ? "pending" : "unknown",
            reason: `async workflow child ${label} process-terminal proof is ${proofState}`,
            ...(bound ? { unresolvedProof: { status: childStatus, proofState } } : {}),
        };
    }
    return { state: "resolved", proof };
}
function unresolved(runId, state, dispatchClosed, reason) {
    return { version: 1, kind: "workflow", runId, state, dispatchClosed, reason };
}
/** A persistent workflow host is terminal only after dispatch closes and every async child has process evidence. */
export function readWorkflowTerminalProof(asyncDir, steps, summary, hostCommandCount, closedAt) {
    const runId = summary.workflowRunId;
    if (!summary.inventoryComplete || !TERMINAL_WORKFLOW_STATES.has(summary.workflowState)) {
        return unresolved(runId, "pending", false, "Workflow dispatch is still open.");
    }
    if (hostCommandCount > 0) {
        return unresolved(runId, "unknown", true, "Workflow host commands have no process-terminal proof.");
    }
    const evidence = readWorkflowChildProcessEvidence(asyncDir, steps);
    if (evidence.state !== "observed")
        return unresolved(runId, evidence.state, true, evidence.reason);
    const observedAt = Math.max(closedAt, ...evidence.children.map((child) => child.state === "observed" ? child.observedAt : 0));
    return { version: 1, kind: "workflow", runId, state: "observed", dispatchClosed: true, observedAt, children: evidence.children };
}
