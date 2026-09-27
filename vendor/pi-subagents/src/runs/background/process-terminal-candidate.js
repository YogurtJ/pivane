import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.js";
export function isRecord(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
export function validProcessInstance(value, kind) {
    if (!isRecord(value))
        return false;
    if (typeof value.processInstanceId !== "string" || value.processInstanceId.length === 0)
        return false;
    if (kind ? value.kind !== kind : (value.kind !== "runner" && value.kind !== "pi-writer"))
        return false;
    if (typeof value.closeObservedAt !== "number" || !Number.isFinite(value.closeObservedAt))
        return false;
    if (typeof value.exitCode !== "number" && value.exitCode !== null)
        return false;
    if (typeof value.signal !== "string" && value.signal !== null)
        return false;
    if (value.kind === "runner")
        return value.attempt === undefined;
    if (typeof value.attempt !== "number" || !Number.isInteger(value.attempt) || value.attempt < 0 || !isRecord(value.processTree))
        return false;
    if (value.processTree.state === "observed") {
        return value.processTree.mechanism === "posix-process-group"
            && typeof value.processTree.processGroupId === "number"
            && Number.isInteger(value.processTree.processGroupId)
            && value.processTree.processGroupId > 0
            && typeof value.processTree.verifiedAt === "number"
            && Number.isFinite(value.processTree.verifiedAt);
    }
    return value.processTree.state === "unknown"
        && ["unsupported-platform", "signal-failed", "verification-failed"].includes(String(value.processTree.reason))
        && (value.processTree.diagnostic === undefined || typeof value.processTree.diagnostic === "string");
}
function validInstance(value) {
    return validProcessInstance(value, "pi-writer");
}
export function processTerminalCandidatePath(asyncDir) {
    return path.join(asyncDir, "process-terminal-candidate.json");
}
export function readProcessTerminalCandidate(asyncDir) {
    try {
        const raw = JSON.parse(fs.readFileSync(processTerminalCandidatePath(asyncDir), "utf-8"));
        if (!isRecord(raw) || raw.version !== 1 || typeof raw.runId !== "string" || typeof raw.runnerProcessInstanceId !== "string" || !isRecord(raw.writers)) {
            throw new Error(`Invalid process-terminal candidate in '${asyncDir}'.`);
        }
        const writers = {};
        for (const [index, entries] of Object.entries(raw.writers)) {
            if (!Array.isArray(entries) || !entries.every(validInstance))
                throw new Error(`Invalid writer process records for child '${index}'.`);
            writers[index] = entries;
        }
        let expectedWriters;
        if (raw.expectedWriters !== undefined) {
            if (!isRecord(raw.expectedWriters))
                throw new Error("Invalid expected writer process records.");
            expectedWriters = {};
            for (const [index, count] of Object.entries(raw.expectedWriters)) {
                if (typeof count !== "number" || !Number.isInteger(count) || count < 0)
                    throw new Error(`Invalid expected writer count for child '${index}'.`);
                expectedWriters[index] = count;
            }
        }
        if (raw.sessionFile !== undefined && typeof raw.sessionFile !== "string")
            throw new Error("Invalid process-terminal candidate sessionFile.");
        if (raw.revivalLeaseToken !== undefined && typeof raw.revivalLeaseToken !== "string")
            throw new Error("Invalid process-terminal candidate lease token.");
        if (raw.revivalLeaseReleaseAcknowledged !== undefined && typeof raw.revivalLeaseReleaseAcknowledged !== "boolean")
            throw new Error("Invalid process-terminal lease release acknowledgement.");
        return {
            version: 1,
            runId: raw.runId,
            runnerProcessInstanceId: raw.runnerProcessInstanceId,
            writers,
            ...(expectedWriters ? { expectedWriters } : {}),
            ...(typeof raw.sessionFile === "string" && raw.sessionFile ? { sessionFile: raw.sessionFile } : {}),
            ...(typeof raw.revivalLeaseToken === "string" && raw.revivalLeaseToken ? { revivalLeaseToken: raw.revivalLeaseToken } : {}),
            ...(typeof raw.revivalLeaseReleaseAcknowledged === "boolean" ? { revivalLeaseReleaseAcknowledged: raw.revivalLeaseReleaseAcknowledged } : {}),
        };
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function writeProcessTerminalCandidate(asyncDir, candidate) {
    writePrivateAtomicJson(processTerminalCandidatePath(asyncDir), candidate);
}
export function markProcessTerminalCandidateLeaseRelease(asyncDir, token, acknowledged) {
    const candidate = readProcessTerminalCandidate(asyncDir);
    if (!candidate || candidate.revivalLeaseToken !== token)
        return;
    writeProcessTerminalCandidate(asyncDir, { ...candidate, revivalLeaseReleaseAcknowledged: acknowledged });
}
//# sourceMappingURL=process-terminal-candidate.js.map