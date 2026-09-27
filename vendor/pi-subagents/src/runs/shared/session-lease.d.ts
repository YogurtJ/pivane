export declare const SESSION_LEASES_DIR: string;
export interface SessionLeaseRequest {
    sessionFile: string;
    runId: string;
    sourceRunId: string;
    parentSessionId?: string;
}
export interface SessionLeaseOwner {
    version: 1;
    token: string;
    canonicalSessionFile: string;
    runId: string;
    sourceRunId: string;
    parentSessionId?: string;
    pid: number;
    hostname: string;
    processStartIdentity?: string;
    writerState: "none" | "spawning" | "running";
    writerPid?: number;
    writerProcessStartIdentity?: string;
    acquiredAt: string;
    acquiredAtMs: number;
    updatedAtMs: number;
}
export interface SessionLeaseHandle {
    leaseDir: string;
    owner: SessionLeaseOwner;
    updateWriter(writer: {
        state: "none" | "spawning";
    } | {
        state: "running";
        pid: number;
    }): void;
    release(): boolean;
}
export type SessionLeaseState = {
    state: "free";
    canonicalSessionFile: string;
    canonicalSessionId: string;
} | {
    state: "owned";
    canonicalSessionFile: string;
    canonicalSessionId: string;
    owner: SessionLeaseOwner;
} | {
    state: "unreadable";
    canonicalSessionFile: string;
    canonicalSessionId: string;
};
interface SessionLeaseOptions {
    rootDir?: string;
    now?: () => number;
    token?: () => string;
    pid?: number;
    hostname?: string;
    processStartIdentity?: string;
    isProcessAlive?: (pid: number) => boolean | undefined;
    getProcessStartIdentity?: (pid: number) => string | undefined;
}
export declare class SessionLeaseConflictError extends Error {
    readonly owner?: SessionLeaseOwner;
    constructor(message: string, owner?: SessionLeaseOwner);
}
export declare function canonicalSessionFilePath(sessionFile: string): string;
export declare function canonicalSessionId(sessionFile: string): string;
export declare function sessionLeaseDir(sessionFile: string, rootDir?: string): string;
export declare function inspectSessionLease(sessionFile: string, rootDir?: string): SessionLeaseState;
export declare function acquireSessionLease(request: SessionLeaseRequest, options?: SessionLeaseOptions): SessionLeaseHandle;
export {};
//# sourceMappingURL=session-lease.d.ts.map