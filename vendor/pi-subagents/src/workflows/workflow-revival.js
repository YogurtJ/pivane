import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../shared/atomic-json.js";
import { readStatus } from "../shared/utils.js";
/**
 * A top-level resume of a failed async workflow child starts a detached run. These records
 * link that run back to its workflow key without writing the workflow's own status or receipt.
 * The source run is terminal, so the live workflow host never writes its directory.
 */
const REVIVAL_LINK_FILE = "workflow-revival.json";
/** The same link, kept in the revived run's directory so reviving it again keeps the key. */
export const REVIVAL_ORIGIN_FILE = "workflow-revival-origin.json";
/** Recording refuses a deeper link, so readers bounded by this always reach the chain's end. */
const MAX_REVIVAL_DEPTH = 16;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function isRunId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 255 && path.basename(value) === value && value !== "." && value !== "..";
}
function readLink(file) {
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const link = value;
    if (link.version !== 1 || !isRunId(link.workflowRunId) || typeof link.workflowKey !== "string" || !KEY_PATTERN.test(link.workflowKey) || !isRunId(link.sourceRunId) || !isRunId(link.revivedRunId))
        return undefined;
    if (!Number.isInteger(link.depth) || link.depth < 1 || link.depth > MAX_REVIVAL_DEPTH)
        return undefined;
    return { version: 1, workflowRunId: link.workflowRunId, workflowKey: link.workflowKey, sourceRunId: link.sourceRunId, revivedRunId: link.revivedRunId, depth: link.depth };
}
/**
 * Links a detached revival to the workflow key of its source run when the source failed and is
 * an async workflow child or an earlier revival of one. Throws when the source status cannot be
 * read or the key's revival chain is full; the caller reports that on the revive receipt.
 */
export function recordWorkflowRevival(asyncDirRoot, sourceRunId, revivedRunId) {
    const sourceDir = path.join(asyncDirRoot, sourceRunId);
    const status = readStatus(sourceDir);
    if (status?.runId !== sourceRunId || status.state !== "failed")
        return;
    const origin = isRunId(status.parentWorkflowRunId) && typeof status.workflowKey === "string" && KEY_PATTERN.test(status.workflowKey)
        ? { workflowRunId: status.parentWorkflowRunId, workflowKey: status.workflowKey, depth: 0 }
        : readLink(path.join(sourceDir, REVIVAL_ORIGIN_FILE));
    if (!origin || ("revivedRunId" in origin && origin.revivedRunId !== sourceRunId))
        return;
    if (origin.depth >= MAX_REVIVAL_DEPTH)
        throw new Error(`workflow key '${origin.workflowKey}' of ${origin.workflowRunId} already has ${MAX_REVIVAL_DEPTH} chained revivals.`);
    const link = { version: 1, workflowRunId: origin.workflowRunId, workflowKey: origin.workflowKey, sourceRunId, revivedRunId, depth: origin.depth + 1 };
    const originFile = path.join(asyncDirRoot, revivedRunId, REVIVAL_ORIGIN_FILE);
    writePrivateAtomicJson(originFile, link);
    try {
        writePrivateAtomicJson(path.join(sourceDir, REVIVAL_LINK_FILE), link);
    }
    catch (error) {
        // Keep the origin exactly when the published link names this revival: an unlinked origin
        // would only pin the run against retention, and a linked one protects the key's chain.
        if (readLink(path.join(sourceDir, REVIVAL_LINK_FILE))?.revivedRunId !== revivedRunId)
            fs.rmSync(originFile, { force: true });
        throw error;
    }
}
/**
 * Follows revival links from one run of a workflow key by exact reads. Returns undefined when
 * the run was never revived; malformed or mismatched links end the chain.
 */
export function projectWorkflowKeyRevival(asyncDirRoot, workflowRunId, workflowKey, runId) {
    if (!isRunId(runId))
        return undefined;
    const revivedRunIds = [];
    let current = runId;
    while (revivedRunIds.length < MAX_REVIVAL_DEPTH) {
        const link = readLink(path.join(asyncDirRoot, current, REVIVAL_LINK_FILE));
        if (!link || link.sourceRunId !== current || link.workflowRunId !== workflowRunId || link.workflowKey !== workflowKey)
            break;
        revivedRunIds.push(link.revivedRunId);
        current = link.revivedRunId;
    }
    if (revivedRunIds.length === 0)
        return undefined;
    let status = null;
    try {
        status = readStatus(path.join(asyncDirRoot, current));
    }
    catch {
        // Readers show "status unavailable" instead of failing the workflow's status or notice.
    }
    return { revivedRunIds, latestRunId: current, ...(status?.runId === current ? { state: status.state } : {}) };
}
/** `Revived → <run> [→ <run>]: <state>`, shown next to the key's original failure. */
export function formatWorkflowKeyRevival(revival) {
    return `Revived → ${revival.revivedRunIds.join(" → ")}: ${revival.state === "complete" ? "completed" : revival.state ?? "status unavailable"}`;
}
/**
 * Adds each failed child's revivals to its lineage, so the receipt's latest run for that key is
 * the newest revival. The child's own result and evidence stay as they were.
 */
export function withWorkflowRevivals(asyncDirRoot, workflowRunId, children) {
    return children.map((child) => {
        if (child.ok || child.state === "running" || !child.runId)
            return child;
        const lineage = child.continuation?.runIds ?? [child.runId];
        const revival = projectWorkflowKeyRevival(asyncDirRoot, workflowRunId, child.key, lineage.at(-1) ?? child.runId);
        return revival ? { ...child, continuation: { runIds: [...lineage, ...revival.revivedRunIds] }, revival } : child;
    });
}
//# sourceMappingURL=workflow-revival.js.map