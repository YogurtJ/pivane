import * as fs from "node:fs";
import { readAsyncRecoveryDescriptor } from "./async-resume.js";
const INTERCOM_DETACH_ERROR = "detached for intercom coordination";
function isIntercomDetached(run) {
    return run.steps.some((step) => step.execution?.status === "detached"
        || step.error?.toLowerCase().includes(INTERCOM_DETACH_ERROR) === true)
        || run.error?.toLowerCase().includes(INTERCOM_DETACH_ERROR) === true;
}
function formatIntercomDetachGuidance(run) {
    if (!isIntercomDetached(run))
        return undefined;
    return `Run "${run.id}" detached for intercom coordination. Reply to the supervisor request first, then wait with bg_wait({ id: "${run.id}" }). Use subagent({ action: "status", id: "${run.id}" }) to recover the result; do not resume or launch a replacement while it remains detached.`;
}
export function formatAsyncReviveCommand(run) {
    const step = run.steps.find((candidate) => candidate.status === "failed");
    const sessionFile = step?.sessionFile ?? (run.steps.length === 1 ? run.sessionFile : undefined);
    if (!step || !sessionFile || !fs.existsSync(sessionFile))
        return undefined;
    try {
        const descriptor = readAsyncRecoveryDescriptor(run.asyncDir);
        if (!descriptor || descriptor.sourceRunId !== run.id || descriptor.agent !== step.agent)
            return undefined;
    }
    catch {
        return undefined;
    }
    const index = run.steps.length === 1 ? "" : `, index: ${step.index}`;
    return `subagent({ action: "resume", id: "${run.id}"${index}, message: "Continue from the persisted child session and report the result." })`;
}
export function formatResumeFirstFailedRunDetail(run) {
    if (run.state !== "failed")
        return undefined;
    const detachGuidance = formatIntercomDetachGuidance(run);
    if (detachGuidance)
        return detachGuidance;
    const command = formatAsyncReviveCommand(run);
    if (!command)
        return undefined;
    return `Resume-first: failed run "${run.id}" has a persisted child session. Revive the original run with ${command} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
}
export function formatResumeFirstFailedRunsNote(runs) {
    const failedRuns = runs.filter((run) => run.state === "failed" || run.state === "partial");
    const detachGuidance = failedRuns
        .map(formatIntercomDetachGuidance)
        .filter((guidance) => Boolean(guidance));
    const resumable = failedRuns
        .filter((run) => !isIntercomDetached(run))
        .map((run) => ({ run, command: formatAsyncReviveCommand(run) }))
        .filter((entry) => Boolean(entry.command));
    const resumeGuidance = resumable.length === 0
        ? ""
        : resumable.length === 1
            ? ` Resume-first: failed run "${resumable[0].run.id}" has a persisted child session. Revive the original run with ${resumable[0].command} before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`
            : ` Resume-first: ${resumable.length} failed runs have persisted child sessions. Inspect status and revive each original run before reporting failure or launching a replacement. Launch a replacement only if revive fails or the user explicitly asks for one.`;
    return `${detachGuidance.length > 0 ? ` ${detachGuidance.join(" ")}` : ""}${resumeGuidance}`;
}
//# sourceMappingURL=resume-guidance.js.map