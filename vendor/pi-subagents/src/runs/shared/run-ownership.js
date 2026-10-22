import { inheritedSessionIds } from "../../shared/session-succession.js";
/** The sessions whose runs sessionId owns: itself and the sessions this process replaced on the way to it. */
export function ownerSessionIds(sessionId) {
    return new Set([sessionId, ...inheritedSessionIds(sessionId)]);
}
export function ownsRun(currentSessionId, runSessionId) {
    return currentSessionId ? ownerSessionIds(currentSessionId).has(runSessionId) : false;
}
