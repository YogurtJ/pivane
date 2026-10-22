/** Records that sessionId replaced previousSessionId in this process, inheriting its chain. */
export declare function recordSessionReplacement(sessionId: string, previousSessionId: string): void;
/** Sessions this process replaced on the way to sessionId, newest first; their runs belong to sessionId. */
export declare function inheritedSessionIds(sessionId: string): readonly string[];
