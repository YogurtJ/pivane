import { ownsRun } from "../shared/run-ownership.js";
import { inheritedSessionIds } from "../../shared/session-succession.js";
export function createResultDeliveryOwnership(state) {
    const currentOwner = () => typeof state.completionOwnerId === "string" && state.completionOwnerId
        ? state.completionOwnerId
        : undefined;
    return {
        owns(sessionId, completionOwnerId) {
            const owner = currentOwner();
            if (!owner || completionOwnerId !== owner)
                return false;
            return ownsRun(state.currentSessionId, sessionId);
        },
        claimedSessionIds() {
            if (!currentOwner() || !state.currentSessionId)
                return [];
            return inheritedSessionIds(state.currentSessionId);
        },
    };
}
