import * as fs from "node:fs";
import * as path from "node:path";
import { readStatus } from "../../shared/utils.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { encodeIndexSegment } from "./index-segment.js";
import { isSafeNestedPathId } from "../shared/nested-path.js";
export const TERMINAL_RUN_INDEX_DIR = ".terminal-runs";
const TERMINAL_RUN_INDEX_VERSION = 1;
const TIMESTAMP_WIDTH = 16;
// Literal @ cannot occur in an encoded session key.
const TOOL_CALL_INDEX_DIR = "@tool-calls";
function isTerminalState(state) {
    return state === "complete" || state === "failed" || state === "partial" || state === "paused" || state === "stopped" || state === "rejected";
}
function indexRoot(asyncDirRoot) {
    return path.join(asyncDirRoot, TERMINAL_RUN_INDEX_DIR);
}
function sessionIndexDir(asyncDirRoot, sessionId) {
    return path.join(indexRoot(asyncDirRoot), encodeIndexSegment(sessionId));
}
function toolCallIndexDir(asyncDirRoot, toolCallId) {
    return path.join(indexRoot(asyncDirRoot), TOOL_CALL_INDEX_DIR, encodeIndexSegment(toolCallId));
}
function toolCallMarkerName(runId) {
    return `${encodeIndexSegment(runId, 250)}.json`;
}
function markerName(endedAt, runId) {
    return `${Math.max(0, Math.floor(endedAt)).toString().padStart(TIMESTAMP_WIDTH, "0")}-${encodeIndexSegment(runId)}.json`;
}
function markerPath(asyncDir, sessionId, endedAt) {
    return path.join(sessionIndexDir(path.dirname(asyncDir), sessionId), markerName(endedAt, path.basename(asyncDir)));
}
function parseEntry(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const entry = value;
    if (entry.version !== TERMINAL_RUN_INDEX_VERSION
        || typeof entry.runId !== "string" || !entry.runId
        || typeof entry.sessionId !== "string" || !entry.sessionId
        || typeof entry.endedAt !== "number" || !Number.isFinite(entry.endedAt))
        return undefined;
    return { version: TERMINAL_RUN_INDEX_VERSION, runId: entry.runId, sessionId: entry.sessionId, endedAt: entry.endedAt };
}
export function updateTerminalRunIndex(asyncDir, status) {
    if (!isTerminalState(status.state) || typeof status.sessionId !== "string" || !status.sessionId)
        return;
    const endedAt = status.endedAt ?? status.lastUpdate ?? status.startedAt;
    const marker = markerPath(asyncDir, status.sessionId, endedAt);
    const entry = {
        version: TERMINAL_RUN_INDEX_VERSION,
        runId: status.runId || path.basename(asyncDir),
        sessionId: status.sessionId,
        endedAt,
    };
    writeAtomicJson(marker, entry);
    if (status.toolCallId) {
        try {
            writeAtomicJson(path.join(toolCallIndexDir(path.dirname(asyncDir), status.toolCallId), toolCallMarkerName(entry.runId)), entry);
        }
        catch (error) {
            // Optional aliases must not block authoritative terminal indexing or capacity release.
            console.error(`Failed to write async terminal-run tool-call index for '${asyncDir}':`, error);
        }
    }
}
function removeInvalidMarker(marker) {
    try {
        fs.rmSync(marker, { force: true });
    }
    catch {
        // An advisory marker can remain for a later read when cleanup is contended.
    }
}
function markerFiles(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
            .map((entry) => ({ dir, name: entry.name }));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return [];
        throw error;
    }
}
function sessionDirs(asyncDirRoot, sessionId) {
    if (sessionId)
        return [sessionIndexDir(asyncDirRoot, sessionId)];
    try {
        return fs.readdirSync(indexRoot(asyncDirRoot), { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name !== TOOL_CALL_INDEX_DIR)
            .map((entry) => path.join(indexRoot(asyncDirRoot), entry.name));
    }
    catch (error) {
        const code = error.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return [];
        throw error;
    }
}
function recentMarkerFiles(dirs, limit) {
    return dirs.flatMap(markerFiles)
        .sort((left, right) => right.name.localeCompare(left.name))
        .slice(0, limit)
        .map((marker) => path.join(marker.dir, marker.name));
}
export function readTerminalRunToolCallIndex(asyncDirRoot, toolCallId) {
    const runIds = [];
    for (const file of markerFiles(toolCallIndexDir(asyncDirRoot, toolCallId))) {
        const marker = path.join(file.dir, file.name);
        let entry;
        try {
            entry = parseEntry(JSON.parse(fs.readFileSync(marker, "utf-8")));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            if (!(error instanceof SyntaxError))
                throw error;
        }
        if (!entry || !isSafeNestedPathId(entry.runId) || file.name !== toolCallMarkerName(entry.runId)) {
            removeInvalidMarker(marker);
            continue;
        }
        const status = readStatus(path.join(asyncDirRoot, entry.runId));
        if (!status || !isTerminalState(status.state) || status.runId !== entry.runId
            || status.sessionId !== entry.sessionId || status.toolCallId !== toolCallId) {
            removeInvalidMarker(marker);
            continue;
        }
        runIds.push(entry.runId);
    }
    return runIds;
}
export function readRecentTerminalRunIndex(asyncDirRoot, options = {}) {
    const limit = options.limit === undefined ? Number.POSITIVE_INFINITY : Math.max(0, Math.floor(options.limit));
    const candidates = recentMarkerFiles(sessionDirs(asyncDirRoot, options.sessionId), limit);
    const runIds = [];
    const seen = new Set();
    for (const marker of candidates) {
        let entry;
        try {
            entry = parseEntry(JSON.parse(fs.readFileSync(marker, "utf-8")));
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
        }
        if (!entry || (options.sessionId !== undefined && entry.sessionId !== options.sessionId)) {
            removeInvalidMarker(marker);
            continue;
        }
        const asyncDir = path.join(asyncDirRoot, entry.runId);
        const status = readStatus(asyncDir);
        if (!status || !isTerminalState(status.state) || status.sessionId !== entry.sessionId || (status.runId && status.runId !== entry.runId)) {
            removeInvalidMarker(marker);
            continue;
        }
        if (seen.has(entry.runId)) {
            removeInvalidMarker(marker);
            continue;
        }
        seen.add(entry.runId);
        runIds.push(entry.runId);
    }
    return runIds;
}
//# sourceMappingURL=terminal-run-index.js.map