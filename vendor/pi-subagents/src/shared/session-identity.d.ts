interface SessionIdentityManager {
    getSessionFile(): string | null | undefined;
    getSessionId(): string | null | undefined;
}
export declare function resolveCurrentSessionId(sessionManager: SessionIdentityManager): string;
export {};
//# sourceMappingURL=session-identity.d.ts.map