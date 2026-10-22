/** The sessions whose runs sessionId owns: itself and the sessions this process replaced on the way to it. */
export declare function ownerSessionIds(sessionId: string): ReadonlySet<string | undefined>;
export declare function ownsRun(currentSessionId: string | null | undefined, runSessionId: string | undefined): boolean;
