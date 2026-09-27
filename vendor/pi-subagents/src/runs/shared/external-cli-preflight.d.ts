export type ExternalCliPreflightInvalidationReason = "launch" | "auth" | "parser" | "permission";
export interface ExternalCliPreflightSpec {
    id: string;
    versionArgs: readonly string[];
    helpArgs: readonly string[];
    evidenceArgs?: readonly string[];
    evidenceLabel?: string;
    probeTimeoutMs?: number;
    /** Remote probes include SSH handshakes; values may only narrow the code-owned remote ceiling. */
    remote?: boolean;
    validate?: (result: ExternalCliPreflightResult) => void;
}
export interface ExternalCliPreflightResult {
    binaryPath: string;
    binaryMtimeMs: number;
    version: string;
    help: string;
    evidence?: string;
    cacheHit: boolean;
}
export type ExternalCliBinaryAvailability = {
    available: true;
} | {
    available: false;
    unavailableReason: string;
};
/** Resolve only the configured command; unlike preflight, this never starts a child process. */
export declare function resolveExternalCliBinaryAvailability(command: string, env: NodeJS.ProcessEnv): ExternalCliBinaryAvailability;
export declare function preflightExternalCli(command: string, spec: ExternalCliPreflightSpec, env: NodeJS.ProcessEnv, cwd?: string): ExternalCliPreflightResult;
export declare function invalidateExternalCliPreflight(command: string, spec: ExternalCliPreflightSpec, _reason: ExternalCliPreflightInvalidationReason): void;
export declare function clearExternalCliPreflightCacheForTests(): void;
//# sourceMappingURL=external-cli-preflight.d.ts.map