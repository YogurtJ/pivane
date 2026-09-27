const MAX_CLAIMED_PREDECESSOR_SESSIONS = 8;
export function createResultDeliveryOwnership(state) {
    const claimed = new Map();
    const currentOwner = () => typeof state.completionOwnerId === "string" && state.completionOwnerId
        ? state.completionOwnerId
        : undefined;
    return {
        owns(sessionId, completionOwnerId) {
            const owner = currentOwner();
            if (!owner || completionOwnerId !== owner)
                return false;
            return sessionId === state.currentSessionId || claimed.get(sessionId) === owner;
        },
        claimedSessionIds() {
            const owner = currentOwner();
            if (!owner)
                return [];
            return [...claimed].flatMap(([sessionId, claimedOwner]) => claimedOwner === owner ? [sessionId] : []);
        },
        claimPredecessor(previousSessionFile, previousRuntimeSessionId) {
            const owner = currentOwner();
            if (!owner || !previousSessionFile || !previousRuntimeSessionId)
                return false;
            if (previousSessionFile !== previousRuntimeSessionId || state.currentSessionId !== previousRuntimeSessionId)
                return false;
            claimed.delete(previousRuntimeSessionId);
            claimed.set(previousRuntimeSessionId, owner);
            while (claimed.size > MAX_CLAIMED_PREDECESSOR_SESSIONS)
                claimed.delete(claimed.keys().next().value);
            return true;
        },
        clear() {
            claimed.clear();
        },
    };
}
//# sourceMappingURL=result-delivery-ownership.js.map