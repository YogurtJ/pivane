// Forking a parent transcript into a child must drop Anthropic's signed and redacted
// thinking blocks: a thinking signature is bound to the session that produced it and
// cannot be replayed into a branch. Stripping them is required; disabling the child's
// thinking is not. Pi >= 0.85.0 recovers from signed-thinking mismatches on the
// transport, so a sanitized transcript is safe to resume with thinking enabled and the
// child keeps the level it asked for, reasoning fresh from its first turn.
import * as fs from "node:fs";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
export function resolveSubagentContext(value) {
    return value === "fork" ? "fork" : "fresh";
}
/** Resolve the actual launch context from explicit, global, and agent preferences. */
export function resolveSubagentLaunchContext(input) {
    if (input.explicitContext !== undefined)
        return input.explicitContext;
    const preferredContext = input.defaultSubagentContext ?? input.agentDefaultContext ?? "fresh";
    return preferredContext === "fork" && input.canUseImplicitFork ? "fork" : "fresh";
}
/** True when an implicit `defaultContext: fork` can create a real branch now.
 * Explicit `context: "fork"` stays strict and does not use this preference. */
export function canPreferFork(sessionManager) {
    return canPreferForkFromSnapshot({
        parentSessionFile: sessionManager.getSessionFile(),
        leafId: sessionManager.getLeafId?.() ?? null,
    });
}
export function canPreferForkFromSnapshot(input) {
    if (!input.parentSessionFile || !input.leafId)
        return false;
    try {
        return fs.existsSync(input.parentSessionFile);
    }
    catch {
        return false;
    }
}
function isUnsafeAnthropicThinkingBlock(message, block) {
    if (!message || !block || typeof block !== "object" || !("type" in block))
        return false;
    const provider = typeof message.provider === "string" ? message.provider.toLowerCase() : "";
    const api = typeof message.api === "string" ? message.api.toLowerCase() : "";
    const model = typeof message.model === "string" ? message.model.toLowerCase() : "";
    const isAnthropic = provider === "anthropic" || api === "anthropic-messages" || model.startsWith("anthropic/");
    if (block.type === "redacted_thinking")
        return true;
    if (block.type !== "thinking" || !isAnthropic)
        return false;
    const record = block;
    const signature = "thinkingSignature" in record ? record.thinkingSignature : "signature" in record ? record.signature : undefined;
    return record.redacted === true || (typeof signature === "string" && signature.length > 0);
}
function sanitizeUnsafeThinkingBlocks(entries) {
    let sanitized = false;
    const entriesById = new Map(entries.flatMap((entry) => entry.id ? [[entry.id, entry]] : []));
    for (const entry of entries) {
        const targetMessage = entry.type === "context_edit" && entry.targetId
            ? entriesById.get(entry.targetId)?.message
            : entry.message;
        const contentOwner = entry.type === "context_edit" ? entry.replacement : targetMessage;
        if (targetMessage?.role !== "assistant" || !contentOwner || !Array.isArray(contentOwner.content))
            continue;
        const filtered = contentOwner.content.filter((block) => !isUnsafeAnthropicThinkingBlock(targetMessage, block));
        if (filtered.length === contentOwner.content.length)
            continue;
        contentOwner.content = filtered;
        sanitized = true;
    }
    return sanitized;
}
function readSessionEntries(sessionFile) {
    const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter((line) => line.trim().length > 0);
    return lines.map((line, index) => {
        try {
            return JSON.parse(line);
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            throw new Error(`Unable to inspect forked session ${sessionFile}: invalid JSONL on line ${index + 1}: ${cause.message}`, { cause });
        }
    });
}
export function createForkContextResolver(sessionManager, requestedContext, options = {}) {
    if (resolveSubagentContext(requestedContext) !== "fork") {
        return {
            prepareSessionForIndex: async () => { },
            sessionFileForIndex: () => undefined,
        };
    }
    const parentSessionFile = sessionManager.getSessionFile();
    if (!parentSessionFile) {
        throw new Error("Forked subagent context requires a persisted parent session.");
    }
    const leafId = sessionManager.getLeafId();
    if (!leafId) {
        throw new Error("Forked subagent context requires a current leaf to fork from.");
    }
    const openSession = options.openSession
        ?? sessionManager.openSession
        ?? ((file, dir) => SessionManager.open(file, dir));
    // Fork files must not land in the parent's top-level session directory.
    // Pi's recent-session discovery (`pi -c` → findMostRecentSession) is
    // non-recursive and picks the largest-mtime *.jsonl in that directory, so
    // a still-running forked subagent — which keeps appending after the parent
    // went idle — would hijack the next `pi -c` away from the conversation the
    // user actually left. Nesting fork sessions in a per-parent directory keeps
    // them invisible to that discovery; the `parentSession` header still
    // records the tree relationship. The directory mirrors
    // getSubagentSessionRoot() plus a "forks" level so fork files never sit
    // loose next to run-N/ result directories. Derived from the file path
    // rather than getSessionDir() so it also works when the manager cannot
    // report its directory.
    const sessionDir = path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"), "forks");
    const cachedSessionFiles = new Map();
    const preparedIndexes = new Set();
    const preparationPromises = new Map();
    const resolveFork = (index = 0) => {
        const cached = cachedSessionFiles.get(index);
        if (cached)
            return cached;
        try {
            if (!fs.existsSync(parentSessionFile)) {
                throw new Error(`Parent session file does not exist: ${parentSessionFile}. Pi has not persisted enough history to fork yet.`);
            }
            const sourceManager = openSession(parentSessionFile, sessionDir);
            const sessionFile = sourceManager.createBranchedSession(leafId);
            if (!sessionFile) {
                throw new Error("Session manager did not return a forked session file.");
            }
            if (!fs.existsSync(sessionFile)) {
                const header = sourceManager.getHeader?.();
                const entries = sourceManager.getEntries?.();
                if (!header || !entries) {
                    throw new Error(`Session manager returned a forked session file that does not exist and cannot be persisted by fallback: ${sessionFile}`);
                }
                sanitizeUnsafeThinkingBlocks(entries);
                fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
                fs.writeFileSync(sessionFile, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
            }
            else {
                const entries = readSessionEntries(sessionFile);
                if (sanitizeUnsafeThinkingBlocks(entries)) {
                    fs.writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf-8");
                }
            }
            cachedSessionFiles.set(index, sessionFile);
            return sessionFile;
        }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            throw new Error(`Failed to create forked subagent session: ${cause.message}`, { cause });
        }
    };
    return {
        async prepareSessionForIndex(index = 0) {
            const sessionFile = resolveFork(index);
            if (!options.pruneSession || preparedIndexes.has(index))
                return;
            let preparation = preparationPromises.get(index);
            if (!preparation) {
                preparation = options.pruneSession(sessionFile).then(() => {
                    preparedIndexes.add(index);
                });
                preparationPromises.set(index, preparation);
            }
            await preparation;
        },
        sessionFileForIndex(index = 0) {
            if (options.pruneSession && !preparedIndexes.has(index)) {
                throw new Error(`Pruned fork session ${index} was used before pruning completed.`);
            }
            return resolveFork(index);
        },
    };
}
//# sourceMappingURL=fork-context.js.map