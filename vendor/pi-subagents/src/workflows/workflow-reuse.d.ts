import { type WorkflowScriptChildResult } from "./scripted-workflow.ts";
/** Stop cause recorded when the extension runtime that owned the workflow was replaced (/reload, resume, project switch). */
declare const WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED = "runtime-replaced";
type WorkflowStopCause = typeof WORKFLOW_STOP_CAUSE_RUNTIME_REPLACED;
export declare function workflowRuntimeReplacedRelaunchNotice(runId: string): string;
/** Abort reason for workflow controllers torn down by runtime replacement; carries the cause as data, not text. */
export declare function runtimeReplacedAbortReason(): Error;
export declare function workflowStopCause(reason: unknown): WorkflowStopCause | undefined;
export declare function workflowScriptDigest(script: string): string;
/** Hash of the canonical launch params the script host uses to detect duplicate keys. */
export declare function workflowChildFingerprint(params: Record<string, unknown>): string;
type WorkflowChildJournalRecord = {
    type: "start";
    key: string;
    fingerprint: string;
    runId: string;
} | {
    type: "settle";
    key: string;
    fingerprint: string;
    result: WorkflowScriptChildResult;
};
/** Appends synchronously. A lost record only means a later relaunch runs that child again. */
export declare function appendWorkflowChildJournal(workflowAsyncDir: string, record: WorkflowChildJournalRecord): void;
interface WorkflowReuseSource {
    runId: string;
    started: Map<string, {
        fingerprint: string;
        runId: string;
    }>;
    settled: Map<string, {
        fingerprint: string;
        result: WorkflowScriptChildResult;
    }>;
}
type WorkflowReuseMatch = {
    kind: "settled";
    result: WorkflowScriptChildResult;
} | {
    kind: "started";
    runId: string;
};
/**
 * The newest terminal workflow of this session with the same script and args,
 * when that run stopped because its runtime was replaced.
 */
export declare function findWorkflowReuseSource(asyncDirRoot: string, sessionId: string, scriptDigest: string, argsDigest: string | undefined): WorkflowReuseSource | undefined;
/**
 * The runtime-replaced workflow run named by `options.reuseFrom`, from any session. Only the script
 * must match: each child is still reused only when its key and launch params match.
 */
export declare function readNamedWorkflowReuseSource(asyncDirRoot: string, runId: string, scriptDigest: string, cwd: string): WorkflowReuseSource;
/** A settled match is reusable only when that child succeeded; failed or stopped children run again. */
export declare function matchWorkflowReuse(source: WorkflowReuseSource, key: string, fingerprint: string): WorkflowReuseMatch | undefined;
export {};
