import * as fs from "node:fs";
import * as path from "node:path";
import { DIRS } from "../../shared/types.js";
import { writePrivateAtomicJson } from "../../shared/atomic-json.js";
import { utf8Tail } from "../../shared/utf8.js";
import { validateAcceptanceInput } from "../shared/acceptance.js";
import { validateModelResponseAliases } from "../../shared/model-response-aliases.js";
export const MAX_REMEMBERED_FOREGROUND_RUNS = 50;
const HISTORY_VERSION = 1;
const MAX_INLINE_OUTPUT_BYTES = 64 * 1024;
const MAX_RESUME_CONTRACT_BYTES = 64 * 1024;
function historyPath(resultsDir) {
    return path.join(resultsDir, "foreground-history.json");
}
function boundedTail(value) {
    return utf8Tail(value, MAX_INLINE_OUTPUT_BYTES).text;
}
function compactChild(child) {
    const outputPath = child.artifactPaths?.outputPath ?? child.savedOutputPath;
    return {
        agent: child.agent,
        index: child.index,
        ...(child.sessionName ? { sessionName: child.sessionName } : {}),
        ...(child.context ? { context: child.context } : {}),
        ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
        ...(child.model ? { model: child.model } : {}),
        ...(child.thinking ? { thinking: child.thinking } : {}),
        status: child.status,
        ...(child.activityState ? { activityState: child.activityState } : {}),
        ...(child.lastActivityAt !== undefined ? { lastActivityAt: child.lastActivityAt } : {}),
        ...(child.currentTool ? { currentTool: child.currentTool } : {}),
        ...(child.currentToolStartedAt !== undefined ? { currentToolStartedAt: child.currentToolStartedAt } : {}),
        ...(child.currentPath ? { currentPath: child.currentPath } : {}),
        ...(child.turnCount !== undefined ? { turnCount: child.turnCount } : {}),
        ...(child.tokens !== undefined ? { tokens: child.tokens } : {}),
        ...(child.toolCount !== undefined ? { toolCount: child.toolCount } : {}),
        ...(child.exitCode !== undefined ? { exitCode: child.exitCode } : {}),
        ...(child.error ? { error: child.error } : {}),
        ...(!outputPath && child.finalOutput ? { finalOutput: boundedTail(child.finalOutput) } : {}),
        ...(child.outputState ? { outputState: child.outputState } : {}),
        ...(child.outputMode ? { outputMode: child.outputMode } : {}),
        ...(child.savedOutputPath ? { savedOutputPath: child.savedOutputPath } : {}),
        ...(child.outputSaveError ? { outputSaveError: child.outputSaveError } : {}),
        ...(child.artifactPaths ? { artifactPaths: child.artifactPaths } : {}),
        ...(child.transcriptPath ? { transcriptPath: child.transcriptPath } : {}),
        ...(child.transcriptError ? { transcriptError: child.transcriptError } : {}),
        ...(child.acceptance ? { acceptance: child.acceptance } : {}),
        ...(child.resumeContract ? { resumeContract: child.resumeContract } : {}),
        ...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
        ...(child.extensionBindings ? { extensionBindings: child.extensionBindings } : {}),
        ...(child.requiredExtensions ? { requiredExtensions: child.requiredExtensions } : {}),
        ...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
        ...(child.updatedAt !== undefined ? { updatedAt: child.updatedAt } : {}),
    };
}
function isRestorableForegroundStatus(status) {
    return status === "completed" || status === "failed" || status === "paused" || status === "stopped";
}
function isRestorableResumeContract(value) {
    if (value === undefined)
        return true;
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    try {
        if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_RESUME_CONTRACT_BYTES)
            return false;
        validateModelResponseAliases(value?.modelResponseAliases);
    }
    catch {
        return false;
    }
    const contract = value;
    if (Object.keys(contract).some((key) => !["modelResponseAliases", "outputSchema", "agentContract", "acceptance", "output", "outputMode"].includes(key)))
        return false;
    if (contract.outputSchema !== undefined && contract.outputSchema !== false && (!contract.outputSchema || typeof contract.outputSchema !== "object" || Array.isArray(contract.outputSchema)))
        return false;
    if (contract.agentContract !== undefined && (!contract.agentContract || typeof contract.agentContract !== "object" || Array.isArray(contract.agentContract) || contract.agentContract.version !== 1))
        return false;
    if (validateAcceptanceInput(contract.acceptance).length > 0)
        return false;
    if (contract.output !== undefined && typeof contract.output !== "string" && typeof contract.output !== "boolean")
        return false;
    return contract.outputMode === undefined || contract.outputMode === "inline" || contract.outputMode === "file-only";
}
function compactRun(run) {
    if (!run.sessionId)
        return undefined;
    if (run.children.length === 0 || !run.children.every((child) => isRestorableForegroundStatus(child.status) && isRestorableResumeContract(child.resumeContract)))
        return undefined;
    return {
        runId: run.runId,
        mode: run.mode,
        cwd: run.cwd,
        sessionId: run.sessionId,
        updatedAt: run.updatedAt,
        children: run.children.map(compactChild),
    };
}
function readIndex(resultsDir) {
    const filePath = historyPath(resultsDir);
    if (!fs.existsSync(filePath))
        return { version: HISTORY_VERSION, runs: [] };
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return { version: HISTORY_VERSION, runs: [] };
        const record = parsed;
        if (record.version !== HISTORY_VERSION || !Array.isArray(record.runs))
            return { version: HISTORY_VERSION, runs: [] };
        return { version: HISTORY_VERSION, runs: record.runs.filter(isRestorableRun) };
    }
    catch {
        return { version: HISTORY_VERSION, runs: [] };
    }
}
function isRestorableRun(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const run = value;
    return typeof run.runId === "string" && Boolean(run.runId)
        && (run.mode === "single" || run.mode === "parallel" || run.mode === "chain")
        && typeof run.cwd === "string" && Boolean(run.cwd)
        && typeof run.sessionId === "string" && Boolean(run.sessionId)
        && typeof run.updatedAt === "number" && Number.isFinite(run.updatedAt)
        && Array.isArray(run.children)
        && run.children.length > 0
        && run.children.every((child) => Boolean(child && typeof child === "object" && !Array.isArray(child)
            && typeof child.agent === "string"
            && typeof child.index === "number"
            && isRestorableResumeContract(child.resumeContract)
            && isRestorableForegroundStatus(child.status)));
}
function sortAndBound(runs, limit) {
    return [...runs].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit);
}
export function persistForegroundRunHistory(state, options = {}) {
    const resultsDir = options.resultsDir ?? DIRS.results;
    const limit = options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS;
    const existing = readIndex(resultsDir);
    const merged = new Map(existing.runs.map((run) => [run.runId, run]));
    for (const run of state.foregroundRuns?.values() ?? []) {
        const compact = compactRun(run);
        if (compact)
            merged.set(compact.runId, compact);
    }
    const runs = sortAndBound([...merged.values()], limit);
    writePrivateAtomicJson(historyPath(resultsDir), { version: HISTORY_VERSION, runs });
}
export function restoreForegroundRunHistory(state, options = {}) {
    const sessionId = options.sessionId ?? state.currentSessionId;
    if (!sessionId)
        return 0;
    const index = readIndex(options.resultsDir ?? DIRS.results);
    const runs = sortAndBound(index.runs.filter((run) => run.sessionId === sessionId), options.limit ?? MAX_REMEMBERED_FOREGROUND_RUNS);
    state.foregroundRuns ??= new Map();
    let restored = 0;
    for (const run of runs) {
        if (state.foregroundRuns.has(run.runId))
            continue;
        state.foregroundRuns.set(run.runId, run);
        restored += 1;
    }
    return restored;
}
//# sourceMappingURL=foreground-history.js.map