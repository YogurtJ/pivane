import * as fs from "node:fs";
import * as path from "node:path";
import { writePrivateAtomicJson } from "../../shared/atomic-json.js";
import { utf8Tail } from "../../shared/utf8.js";
const REPLAY_VERSION = 1;
const ARCHIVE_VERSION = 1;
const ARCHIVE_TEXT_LIMIT_BYTES = 64 * 1024;
const REPLAY_DIR_NAME = "completion-replay";
const ARCHIVE_DIR_NAME = "output-archives";
const CLEANUP_INTERVAL_MS = 60_000;
const lastCleanupByResultsDir = new Map();
function safeRunFile(runId) {
    return `${encodeURIComponent(runId)}.json`;
}
export function completionReplayPath(resultsDir, runId) {
    return path.join(resultsDir, REPLAY_DIR_NAME, safeRunFile(runId));
}
export function completionArchivePath(resultsDir, runId) {
    return path.join(resultsDir, ARCHIVE_DIR_NAME, safeRunFile(runId));
}
function nonEmptyString(value) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}
function existingFile(value) {
    const filePath = nonEmptyString(value);
    if (!filePath)
        return undefined;
    try {
        return fs.statSync(filePath).isFile() ? filePath : undefined;
    }
    catch {
        return undefined;
    }
}
function outputArtifactPath(child) {
    if (!child.artifactPaths || typeof child.artifactPaths !== "object" || Array.isArray(child.artifactPaths))
        return undefined;
    return existingFile(child.artifactPaths.outputPath);
}
/** Create a small archive that references saved child artifacts and retains only bounded fallback output text. */
export function writeCompletionArchive(resultsDir, runId, data, createdAt) {
    const entries = [];
    const results = Array.isArray(data.results) ? data.results : [];
    for (let resultIndex = 0; resultIndex < results.length; resultIndex++) {
        const value = results[resultIndex];
        if (!value || typeof value !== "object" || Array.isArray(value))
            continue;
        const child = value;
        const agent = nonEmptyString(child.agent);
        const artifactPath = outputArtifactPath(child);
        if (artifactPath) {
            entries.push({ ...(agent ? { agent } : {}), resultIndex, source: "output-artifact", path: artifactPath });
            continue;
        }
        const sessionPath = existingFile(child.sessionFile);
        if (sessionPath) {
            entries.push({ ...(agent ? { agent } : {}), resultIndex, source: "session", path: sessionPath });
            continue;
        }
        const output = nonEmptyString(child.output);
        const error = nonEmptyString(child.error);
        if (output || error) {
            const bounded = utf8Tail([error ? `Error: ${error}` : undefined, output].filter(Boolean).join("\n"), ARCHIVE_TEXT_LIMIT_BYTES);
            entries.push({
                ...(agent ? { agent } : {}),
                resultIndex,
                source: "result-tail",
                text: bounded.text,
                ...(bounded.truncated ? { truncated: true } : {}),
            });
        }
    }
    if (results.length === 0) {
        const sessionPath = existingFile(data.sessionFile);
        if (sessionPath)
            entries.push({ source: "session", path: sessionPath });
    }
    if (entries.length === 0) {
        const summary = nonEmptyString(data.summary);
        if (summary) {
            const bounded = utf8Tail(summary, ARCHIVE_TEXT_LIMIT_BYTES);
            entries.push({ source: "result-tail", text: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) });
        }
    }
    const archive = { version: ARCHIVE_VERSION, runId, createdAt, entries };
    const archivePath = completionArchivePath(resultsDir, runId);
    writePrivateAtomicJson(archivePath, archive);
    return archivePath;
}
function parseCompletion(value, runId) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const completion = value;
    if (completion.runId !== runId)
        return undefined;
    return completion;
}
function parseReplay(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const record = value;
    if (record.version !== REPLAY_VERSION
        || typeof record.runId !== "string"
        || typeof record.sessionId !== "string"
        || typeof record.completedAt !== "number"
        || typeof record.expiresAt !== "number"
        || typeof record.archivePath !== "string")
        return undefined;
    const completion = parseCompletion(record.completion, record.runId);
    return completion ? { ...record, completion } : undefined;
}
function validateReplayRecord(resultsDir, runId, record) {
    if (record.runId !== runId)
        return undefined;
    const archivePath = completionArchivePath(resultsDir, runId);
    return path.resolve(record.archivePath) === path.resolve(archivePath)
        ? { ...record, archivePath, completion: { ...record.completion, archivePath } }
        : undefined;
}
function runIdFromReplayFile(file) {
    if (!file.endsWith(".json"))
        return undefined;
    try {
        const runId = decodeURIComponent(file.slice(0, -".json".length));
        return safeRunFile(runId) === file ? runId : undefined;
    }
    catch {
        return undefined;
    }
}
function removeBestEffort(filePath) {
    try {
        fs.rmSync(filePath, { force: true });
    }
    catch { /* cleanup only */ }
}
function parseArchive(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const archive = value;
    if (archive.version !== ARCHIVE_VERSION || typeof archive.runId !== "string" || typeof archive.createdAt !== "number" || !Array.isArray(archive.entries))
        return undefined;
    const entries = archive.entries.flatMap((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
        const entry = value;
        if (entry.source !== "output-artifact" && entry.source !== "session" && entry.source !== "result-tail")
            return [];
        return [{
                ...(typeof entry.agent === "string" ? { agent: entry.agent } : {}),
                ...(typeof entry.resultIndex === "number" && Number.isSafeInteger(entry.resultIndex) && entry.resultIndex >= 0 ? { resultIndex: entry.resultIndex } : {}),
                source: entry.source,
                ...(typeof entry.path === "string" ? { path: entry.path } : {}),
                ...(typeof entry.text === "string" ? { text: entry.text } : {}),
                ...(entry.truncated === true ? { truncated: true } : {}),
            }];
    });
    return { version: ARCHIVE_VERSION, runId: archive.runId, createdAt: archive.createdAt, entries };
}
/** Persist a terminal completion before its one-shot result file is removed. */
export function writeCompletionReplay(input) {
    const archivePath = writeCompletionArchive(input.resultsDir, input.runId, input.data, input.now);
    const completion = { ...input.completion, archivePath };
    const record = {
        version: REPLAY_VERSION,
        runId: input.runId,
        sessionId: input.sessionId,
        completedAt: input.now,
        expiresAt: input.now + input.ttlMs,
        completion,
        archivePath,
    };
    writePrivateAtomicJson(completionReplayPath(input.resultsDir, input.runId), record);
    cleanupCompletionReplayIfDue(input.resultsDir, input.now, input.ttlMs);
    return record;
}
/** Read a current replay record. Unknown fields are ignored and unknown versions are skipped. */
export function readCompletionReplay(resultsDir, runId, options = {}) {
    const replayPath = completionReplayPath(resultsDir, runId);
    let parsed;
    try {
        parsed = parseReplay(JSON.parse(fs.readFileSync(replayPath, "utf-8")));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    if (!parsed)
        return undefined;
    const safeRecord = validateReplayRecord(resultsDir, runId, parsed);
    if (!safeRecord) {
        removeBestEffort(replayPath);
        return undefined;
    }
    parsed = safeRecord;
    if (options.sessionId !== undefined && parsed.sessionId !== options.sessionId)
        return undefined;
    if (parsed.expiresAt <= (options.now ?? Date.now())) {
        removeBestEffort(replayPath);
        removeBestEffort(parsed.archivePath);
        return undefined;
    }
    return parsed;
}
export function readCompletionArchive(archivePath) {
    try {
        const archive = parseArchive(JSON.parse(fs.readFileSync(archivePath, "utf-8")));
        if (!archive)
            throw new Error("Completion archive is malformed.");
        return archive;
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
}
export function cleanupCompletionReplayIfDue(resultsDir, now, maxAgeMs, intervalMs = CLEANUP_INTERVAL_MS) {
    const last = lastCleanupByResultsDir.get(resultsDir);
    if (last !== undefined && now - last < intervalMs)
        return false;
    lastCleanupByResultsDir.set(resultsDir, now);
    cleanupCompletionReplay(resultsDir, now, maxAgeMs);
    return true;
}
/** Opportunistically remove expired replay and orphan archive files without affecting delivery. */
export function cleanupCompletionReplay(resultsDir, now, maxAgeMs) {
    const replayDir = path.join(resultsDir, REPLAY_DIR_NAME);
    try {
        for (const file of fs.readdirSync(replayDir)) {
            const runId = runIdFromReplayFile(file);
            if (!runId)
                continue;
            const filePath = path.join(replayDir, file);
            try {
                const record = parseReplay(JSON.parse(fs.readFileSync(filePath, "utf-8")));
                const safeRecord = record ? validateReplayRecord(resultsDir, runId, record) : undefined;
                if (record && !safeRecord) {
                    fs.rmSync(filePath, { force: true });
                }
                else if (safeRecord && safeRecord.expiresAt <= now) {
                    fs.rmSync(filePath, { force: true });
                    fs.rmSync(safeRecord.archivePath, { force: true });
                }
                else if (!record && now - fs.statSync(filePath).mtimeMs > maxAgeMs) {
                    fs.rmSync(filePath, { force: true });
                }
            }
            catch { /* one bad entry must not block cleanup */ }
        }
    }
    catch { /* replay directory may not exist yet */ }
    const archiveDir = path.join(resultsDir, ARCHIVE_DIR_NAME);
    try {
        for (const file of fs.readdirSync(archiveDir)) {
            const filePath = path.join(archiveDir, file);
            try {
                if (now - fs.statSync(filePath).mtimeMs > maxAgeMs)
                    fs.rmSync(filePath, { force: true });
            }
            catch { /* one bad entry must not block cleanup */ }
        }
    }
    catch { /* archive directory may not exist yet */ }
}
//# sourceMappingURL=completion-replay.js.map