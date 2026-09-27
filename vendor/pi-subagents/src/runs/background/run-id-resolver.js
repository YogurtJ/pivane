import * as fs from "node:fs";
import * as path from "node:path";
import { DIRS } from "../../shared/types.js";
import { readStatus } from "../../shared/utils.js";
import { findAsyncRunPrefixMatches } from "./async-resume.js";
import { resultCandidateFilesForToolCall, resultFilePath, resultPayloadPathForIndexedRun } from "./result-files.js";
import { readActiveRunToolCallIndex } from "./active-run-index.js";
import { assertSafeNestedId, findNestedRunMatchesById } from "../shared/nested-events.js";
function exactAsyncLocation(id, asyncDirRoot, resultsDir) {
    const asyncDir = path.join(asyncDirRoot, id);
    const hasStatus = fs.existsSync(path.join(asyncDir, "status.json"));
    const resultPath = resultPathFor(resultsDir, id);
    if (!hasStatus && !resultPath)
        return undefined;
    return {
        asyncDir: hasStatus ? asyncDir : null,
        resultPath,
        resolvedId: id,
    };
}
function readWorkflowResultIdentity(resultPath) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(resultPath, "utf-8"));
    }
    catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        return undefined;
    const record = parsed;
    return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.runId === "string" ? { runId: record.runId } : {}),
        ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    };
}
function resultPathFor(resultsDir, runId) {
    const resultPath = resultPayloadPathForIndexedRun(resultsDir, runId) ?? resultFilePath(resultsDir, runId);
    return fs.existsSync(resultPath) ? resultPath : null;
}
function toolCallIdMatches(value, query) {
    return value === query;
}
function indexedToolCallIdAsyncLocations(toolCallId, asyncDirRoot, resultsDir) {
    const byId = new Map();
    for (const entry of readActiveRunToolCallIndex(asyncDirRoot, toolCallId)) {
        const asyncDir = path.join(asyncDirRoot, entry);
        const status = readStatus(asyncDir);
        if (!status || !toolCallIdMatches(status.toolCallId, toolCallId))
            continue;
        const runId = status.runId || entry;
        byId.set(runId, { asyncDir, resultPath: resultPathFor(resultsDir, runId), resolvedId: runId });
    }
    for (const entry of resultCandidateFilesForToolCall(resultsDir, toolCallId)) {
        const runIdFromFile = entry.slice(0, -".json".length);
        const resultPath = resultPayloadPathForIndexedRun(resultsDir, runIdFromFile) ?? path.join(resultsDir, entry);
        const identity = readWorkflowResultIdentity(resultPath);
        if (!identity || !toolCallIdMatches(identity.toolCallId, toolCallId))
            continue;
        const runId = identity.runId ?? identity.id ?? runIdFromFile;
        const asyncDir = path.join(asyncDirRoot, runId);
        byId.set(runId, { asyncDir: fs.existsSync(asyncDir) ? asyncDir : null, resultPath, resolvedId: runId });
    }
    return [...byId.entries()].map(([id, location]) => ({ id, location }));
}
function foregroundIds(state) {
    if (!state)
        return [];
    const remembered = state.currentSessionId
        ? [...(state.foregroundRuns?.values() ?? [])]
            .filter((run) => run.sessionId === state.currentSessionId)
            .map((run) => run.runId)
        : [];
    return [...new Set([...state.foregroundControls.keys(), ...remembered])];
}
function hasExactForegroundId(state, id) {
    if (!state)
        return false;
    if (state.foregroundControls.has(id))
        return true;
    const remembered = state.foregroundRuns?.get(id);
    return Boolean(remembered && state.currentSessionId && remembered.sessionId === state.currentSessionId);
}
function exactLiveAsyncToolCallMatch(state, toolCallId, asyncDirRoot, resultsDir) {
    if (!state?.asyncJobs)
        return undefined;
    const matches = [...state.asyncJobs.values()].filter((job) => job.toolCallId === toolCallId);
    if (matches.length > 1)
        throw new Error(`Subagent tool-call id '${toolCallId}' is ambiguous across async runs. Use the returned asyncId instead.`);
    const match = matches[0];
    if (!match)
        return undefined;
    return {
        id: match.asyncId,
        location: {
            asyncDir: fs.existsSync(match.asyncDir) ? match.asyncDir : path.join(asyncDirRoot, match.asyncId),
            resultPath: resultPathFor(resultsDir, match.asyncId),
            resolvedId: match.asyncId,
        },
    };
}
function nestedScopeFromState(state) {
    if (!state)
        return undefined;
    const routes = [];
    const seen = new Set();
    const add = (route) => {
        if (!route)
            return;
        const key = `${route.rootRunId}:${route.eventSink}:${route.controlInbox}`;
        if (seen.has(key))
            return;
        seen.add(key);
        routes.push(route);
    };
    for (const control of state.foregroundControls.values())
        add(control.nestedRoute);
    for (const job of state.asyncJobs.values())
        add(job.nestedRoute);
    if (state.retainedNestedLookupRoutes?.sessionId === state.currentSessionId) {
        for (const route of state.retainedNestedLookupRoutes.routes.values())
            add(route);
    }
    return { routes };
}
function asyncPrefixMatches(prefix, asyncDirRoot, resultsDir) {
    return findAsyncRunPrefixMatches(prefix, asyncDirRoot, resultsDir).filter((match) => match.location.resultPath || (match.location.asyncDir && fs.existsSync(path.join(match.location.asyncDir, "status.json"))));
}
export function resolveSubagentRunId(id, deps = {}) {
    assertSafeNestedId("id", id);
    const asyncDirRoot = deps.asyncDirRoot ?? DIRS.async;
    const resultsDir = deps.resultsDir ?? DIRS.results;
    if (hasExactForegroundId(deps.state, id))
        return { kind: "foreground", id };
    const exactAsync = exactAsyncLocation(id, asyncDirRoot, resultsDir);
    if (exactAsync)
        return { kind: "async", id, location: exactAsync };
    const exactLiveToolCallMatch = exactLiveAsyncToolCallMatch(deps.state, id, asyncDirRoot, resultsDir);
    if (exactLiveToolCallMatch)
        return { kind: "async", id: exactLiveToolCallMatch.id, location: exactLiveToolCallMatch.location };
    const exactToolCallIdMatches = indexedToolCallIdAsyncLocations(id, asyncDirRoot, resultsDir);
    if (exactToolCallIdMatches.length > 1)
        throw new Error(`Subagent tool-call id '${id}' is ambiguous across async runs. Use the returned asyncId instead.`);
    if (exactToolCallIdMatches[0])
        return { kind: "async", id: exactToolCallIdMatches[0].id, location: exactToolCallIdMatches[0].location };
    const nestedScope = deps.nested ?? nestedScopeFromState(deps.state);
    const exactNested = findNestedRunMatchesById(id, nestedScope ? { scope: nestedScope } : {});
    if (exactNested.length > 1)
        throw new Error(`Nested run id '${id}' is ambiguous across authorized registries. Provide the full id after stale registries are cleaned up.`);
    if (exactNested[0])
        return { kind: "nested", id, match: exactNested[0] };
    const matches = [];
    for (const foregroundId of foregroundIds(deps.state).filter((candidate) => candidate.startsWith(id))) {
        matches.push({ kind: "foreground", id: foregroundId });
    }
    for (const match of asyncPrefixMatches(id, asyncDirRoot, resultsDir)) {
        matches.push({ kind: "async", id: match.id, location: match.location });
    }
    for (const match of findNestedRunMatchesById(id, nestedScope ? { prefix: true, scope: nestedScope } : { prefix: true })) {
        matches.push({ kind: "nested", id: match.run.id, match });
    }
    const unique = new Map(matches.map((match) => [`${match.kind}:${match.id}`, match]));
    const values = [...unique.values()];
    if (values.length > 1) {
        throw new Error(`Ambiguous subagent run id prefix '${id}' matched: ${values.map((match) => `${match.kind}:${match.id}`).join(", ")}. Provide a longer id.`);
    }
    return values[0];
}
//# sourceMappingURL=run-id-resolver.js.map