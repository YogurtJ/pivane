import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { workflowPreflightLaneForRuntimeKey } from "./workflow-preflight.js";
export const WORKFLOW_CHAT_PROGRESS_MODES = ["auto", "off", "live-card"];
function git(cwd, args) {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8", windowsHide: true });
    if (result.status !== 0)
        return undefined;
    const output = result.stdout.trim();
    return output || undefined;
}
function realPath(value) {
    try {
        return fs.realpathSync.native(value);
    }
    catch {
        return path.resolve(value);
    }
}
export function resolveGitRepositoryIdentity(cwd) {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true")
        return undefined;
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    const commonDir = git(cwd, ["rev-parse", "--git-common-dir"]);
    if (!root || !commonDir)
        return undefined;
    const commonDirPath = path.isAbsolute(commonDir)
        ? commonDir
        : [path.resolve(cwd, commonDir), path.resolve(root, commonDir)].find((candidate) => fs.existsSync(candidate)) ?? path.resolve(root, commonDir);
    return {
        root: realPath(root),
        commonDir: realPath(commonDirPath),
    };
}
function isSameGitRepositoryIdentity(left, right) {
    if (!left || !right)
        return false;
    return left.commonDir === right.commonDir || left.root === right.root;
}
export function isSameGitRepository(leftCwd, rightCwd) {
    return isSameGitRepositoryIdentity(resolveGitRepositoryIdentity(leftCwd), resolveGitRepositoryIdentity(rightCwd));
}
function normalizeRequestedMode(value) {
    if (value === undefined)
        return { mode: "auto" };
    if (typeof value !== "string" || !WORKFLOW_CHAT_PROGRESS_MODES.includes(value)) {
        return { error: `chatProgress must be one of: ${WORKFLOW_CHAT_PROGRESS_MODES.join(", ")}.` };
    }
    return { mode: value };
}
export function resolveWorkflowChatProgress(input) {
    const requested = normalizeRequestedMode(input.requested);
    if (requested.error)
        return { error: requested.error };
    const parentIdentity = resolveGitRepositoryIdentity(input.parentCwd);
    const workflowIdentity = resolveGitRepositoryIdentity(input.workflowCwd);
    const sameRepo = !!(parentIdentity
        && workflowIdentity
        && (parentIdentity.commonDir === workflowIdentity.commonDir || parentIdentity.root === workflowIdentity.root));
    const repoLabel = workflowIdentity ? path.basename(workflowIdentity.root) : undefined;
    const repoRelation = sameRepo ? "same" : "other";
    const requestedMode = requested.mode ?? "auto";
    let mode;
    if (requestedMode === "auto")
        mode = sameRepo && !input.background ? "live-card" : "off";
    else
        mode = requestedMode;
    if (mode === "live-card" && !sameRepo)
        return { error: "chatProgress: 'live-card' is only available for workflowScript runs in the same Git repository." };
    if (mode === "live-card" && input.background)
        return { error: "chatProgress: 'live-card' is unavailable for async workflowScript. Async workflows have no inline live card; omit chatProgress or use auto/off. Use async:false only when the parent must block." };
    return { projection: { mode, repoRelation, ...(repoLabel ? { repoLabel } : {}) } };
}
function cleanLabel(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
export function buildWorkflowChatProgressRows(trace, preflight) {
    const rows = new Map();
    for (const entry of trace) {
        if (entry.operation !== "run")
            continue;
        const existing = rows.get(entry.key);
        if (entry.state === "reused") {
            if (existing) {
                const label = cleanLabel(entry.label);
                const phase = cleanLabel(entry.phase);
                if (label)
                    existing.label = label;
                if (phase)
                    existing.phase = phase;
            }
            continue;
        }
        const lane = workflowPreflightLaneForRuntimeKey(preflight, entry.key, [entry.generatedLaneKey]);
        const next = existing ?? { key: entry.key, state: "running" };
        if (lane && !next.preflight)
            next.preflight = lane;
        next.state = entry.state === "completed"
            ? "complete"
            : entry.state === "failed"
                ? "failed"
                : entry.state === "detached"
                    ? "detached"
                    : entry.state === "stopped"
                        ? "stopped"
                        : "running";
        const label = cleanLabel(entry.label);
        const phase = cleanLabel(entry.phase);
        if (label)
            next.label = label;
        if (phase)
            next.phase = phase;
        if (entry.runId === undefined)
            delete next.runId;
        else
            next.runId = entry.runId;
        if (entry.durationMs === undefined)
            delete next.durationMs;
        else
            next.durationMs = entry.durationMs;
        if (entry.error === undefined)
            delete next.error;
        else
            next.error = entry.error;
        rows.set(entry.key, next);
    }
    return [...rows.values()];
}
//# sourceMappingURL=chat-progress.js.map