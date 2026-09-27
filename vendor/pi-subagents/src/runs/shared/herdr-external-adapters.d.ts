import type { HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";
import { connectHerdrMachine, type HerdrForwardedConnection } from "./herdr-connection.ts";
import { HerdrPlacedRunOwner, type HerdrReconnectCandidate, type HerdrRunIdentity } from "./herdr-placed-run.ts";
export type HerdrExternalAdapterId = "claude-code" | "claude-code-writer" | "cursor-agent" | "cursor-agent-writer" | "codex-exec" | "codex-exec-writer";
export type HerdrExternalKind = "claude" | "cursor" | "codex";
export interface HerdrExternalCapabilities {
    stop: true;
    steer: false;
    resume: false;
    supervisor: "unsupported";
}
export interface HerdrExternalLaunch {
    adapter: HerdrExternalAdapterId;
    kind: HerdrExternalKind;
    nativeSessionId: string;
    args: string[];
    capabilities: HerdrExternalCapabilities;
}
export interface HerdrExternalResult {
    protocol: 1;
    adapter: HerdrExternalAdapterId;
    runId: string;
    requestId: string;
    nativeSessionId: "unverified";
    nativeTurnId: "unverified";
    outcome: "partial";
    output: string;
    initialGit?: HerdrRemoteGitStatus;
    finalGit?: HerdrRemoteGitStatus;
    settlement?: {
        verification: "best-effort/unverified";
        evidence: "sanitized-terminal-snapshots";
    };
}
export interface HerdrExternalEvidenceInput {
    runId: string;
    requestId: string;
    task: string;
    cwd: string;
    nativeSessionId: string;
    requestedModel?: string;
    initialGit?: unknown;
    finalGit?: unknown;
}
export interface HerdrExternalCommandEvidence {
    binary: string;
    args: readonly string[];
    status: number;
    stdout: string;
    stderr: string;
}
export interface HerdrExternalPreflightEvidence {
    version: HerdrExternalCommandEvidence;
    help: HerdrExternalCommandEvidence;
}
export interface HerdrExternalAdapter {
    readonly id: HerdrExternalAdapterId;
    readonly kind: HerdrExternalKind;
    preflight(evidence: HerdrExternalPreflightEvidence): void;
    launch(input: Omit<Parameters<typeof createHerdrExternalAdapterLaunch>[0], "adapter">): HerdrExternalLaunch;
    normalize(input: HerdrExternalEvidenceInput, evidence: Buffer | string): HerdrExternalResult;
}
export declare function reconcileHerdrExternalRun(identity: HerdrRunIdentity, candidate: HerdrReconnectCandidate): {
    ok: true;
    state: import("./herdr-placed-run.ts").HerdrRunSnapshot["state"];
    paneId: string;
    cursor: number;
} | {
    ok: false;
    reason: string;
};
export declare function validateHerdrExternalPreflight(adapter: HerdrExternalAdapterId, evidence: HerdrExternalPreflightEvidence): void;
export declare function runHerdrExternalPreflight(owner: HerdrPlacedRunOwner, adapter: HerdrExternalAdapterId): HerdrExternalPreflightEvidence;
export declare function createHerdrExternalAdapterLaunch(input: {
    adapter: HerdrExternalAdapterId;
    remoteRuntimeDir: string;
    cwd?: string;
    nativeSessionId?: string;
    model?: string;
    environment?: Readonly<Record<string, string>>;
    resources?: Readonly<Record<string, unknown>>;
}): HerdrExternalLaunch;
export interface HerdrCodexSnapshot {
    at: number;
    workspaceId: string;
    paneId: string;
    terminalId: string;
    pid: number;
    text: string;
    source?: "visible" | "recent_unwrapped";
}
export interface HerdrCodexMonitorClock {
    now(): number;
    wait(ms: number): Promise<void>;
}
export declare class HerdrExternalNeedsAttentionError extends Error {
    readonly code = "HERDR_EXTERNAL_NEEDS_ATTENTION";
    readonly identity: {
        machineId: string;
        workspaceId: string;
        paneId: string;
        terminalId: string;
    };
    constructor(message: string, identity: {
        machineId: string;
        workspaceId: string;
        paneId: string;
        terminalId: string;
    });
}
export declare function monitorHerdrCodex(input: {
    machineId: string;
    task: string;
    preSubmitText: string;
    identity: Omit<HerdrCodexSnapshot, "at" | "text" | "source">;
    snapshot(): Promise<HerdrCodexSnapshot>;
    stop(): Promise<void>;
    timeoutMs?: number;
    clock?: HerdrCodexMonitorClock;
}): Promise<{
    output: string;
    snapshots: number;
}>;
export declare function createHerdrExternalAdapter(id: HerdrExternalAdapterId): HerdrExternalAdapter;
export declare class HerdrExternalSession {
    #private;
    readonly owner: HerdrPlacedRunOwner;
    readonly launch: HerdrExternalLaunch;
    readonly preflight: HerdrExternalPreflightEvidence;
    constructor(owner: HerdrPlacedRunOwner, launch: HerdrExternalLaunch, preflight: HerdrExternalPreflightEvidence, connect?: typeof connectHerdrMachine);
    settle(input: HerdrExternalEvidenceInput, evidence: Buffer | string): HerdrExternalResult;
    promptAndSettle(input: HerdrExternalEvidenceInput, options?: {
        timeoutMs?: number;
        clock?: HerdrCodexMonitorClock;
        snapshot?: () => Promise<HerdrCodexSnapshot>;
    }): Promise<HerdrExternalResult>;
    handleDisconnect(observed?: HerdrForwardedConnection): void;
    reconnect(): Promise<void>;
    retain(): Promise<void>;
    abort(): Promise<void>;
    dispose(): Promise<void>;
}
export declare function prepareInternalHerdrExternalAdapter(input: {
    adapter: HerdrExternalAdapterId;
    machine: HerdrMachineReference;
    runId: string;
}, launch: Omit<Parameters<typeof createHerdrExternalAdapterLaunch>[0], "adapter" | "remoteRuntimeDir" | "cwd">, createOwner?: typeof HerdrPlacedRunOwner.create): Promise<HerdrExternalSession>;
//# sourceMappingURL=herdr-external-adapters.d.ts.map