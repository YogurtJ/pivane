import * as net from "node:net";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";
import type { ChildSession, ChildSessionEvent, ChildSessionFactory, ChildSessionLaunch } from "./child-session.ts";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import { connectHerdrMachine, type HerdrForwardedConnection, type HerdrRpcClient } from "./herdr-connection.ts";
import { HerdrPiFrameDecoder, type HerdrPiFrame } from "./herdr-pi-protocol.ts";
export interface HerdrRunIdentity {
    runId: string;
    machineId: string;
    target: string;
    session: string | null;
    workspaceId: string;
    tabId: string;
    paneId: string;
    terminalId: string;
    agentName: string;
    nativeSessionId: string;
    cwd: string;
    runtimeDir: string;
}
export interface HerdrRunSnapshot {
    connection: "connected" | "unknown" | "closed";
    state: "ready" | "working" | "blocked" | "settled" | "unknown";
    identity?: HerdrRunIdentity;
    revision: number;
}
export interface HerdrReconnectCandidate {
    endpoint: {
        session: string | null;
        protocol: number;
        version: string;
    };
    agents: Array<{
        terminal_id?: string;
        pane_id?: string;
        agent_status?: string;
    }>;
    bridge: {
        runId?: string;
        nativeSessionId?: string;
        packageVersion?: string;
        protocol?: number;
        evidenceCursor?: number;
        evidenceFloor?: number;
    };
}
export declare function herdrStatusSubscriptions(paneId: string): unknown[];
export declare function reconcileHerdrPlacedRun(identity: HerdrRunIdentity, candidate: HerdrReconnectCandidate, proveEvidence: () => {
    ok: true;
    cursor: number;
} | {
    ok: false;
    reason: string;
}): {
    ok: true;
    state: HerdrRunSnapshot["state"];
    paneId: string;
    cursor: number;
} | {
    ok: false;
    reason: string;
};
export declare function reconcileHerdrReconnect(identity: HerdrRunIdentity, candidate: HerdrReconnectCandidate, lastEvidenceCursor: number): {
    ok: true;
    state: HerdrRunSnapshot["state"];
    paneId: string;
    cursor: number;
} | {
    ok: false;
    reason: string;
};
export declare function boundedHerdrReconnect(identity: HerdrRunIdentity, lastEvidenceCursor: number, attempt: (number: number) => Promise<HerdrReconnectCandidate>, options?: {
    attempts?: number;
    deadlineMs?: number;
    disposed?: () => boolean;
}): Promise<{
    ok: true;
    state: HerdrRunSnapshot["state"];
    paneId: string;
    cursor: number;
} | {
    ok: false;
    reason: string;
}>;
export declare function parseHerdrCreated(value: unknown, type: "workspace_created" | "tab_created"): {
    workspaceId?: string;
    tabId: string;
    paneId: string;
};
export declare function parseHerdrAgent(value: unknown, type: "agent_started" | "agent_info" | "agent_prompted"): Record<string, unknown>;
export declare function parseHerdrSessionSnapshot(value: unknown): Record<string, unknown>;
export declare function ownsHerdrPane(agent: Record<string, unknown>, terminalId: string, paneId: string): boolean;
export declare const HERDR_MAX_OWNED_PANES = 20;
export declare function herdrPaneAllocationKey(target: string, session: string | null, cwd: string): string;
export declare function withHerdrPaneAllocationLock<T>(key: string, action: () => Promise<T>, options?: {
    timeoutMs?: number;
    pollMs?: number;
}): Promise<T>;
export declare function serializeHerdrPiLaunch(launch: ChildSessionLaunch): {
    args: string[];
    resources: {
        agent: string;
        skills?: string[];
        toolCeiling?: string[];
        reads?: string[] | false;
    };
};
export declare function provisionHerdrPane(client: HerdrRpcClient, cwd: string, runId: string, runtimeDir: string, environment?: Record<string, string>, allocationKey?: string): Promise<{
    workspaceId: string;
    tabId: string;
    paneId: string;
}>;
export declare function discoverBridgeManifest(machine: HerdrMachineReference, runId: string, runtimeDir: string, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    socketPath: string;
    nativeSessionId: string;
    packageVersion: string;
    protocol: number;
}>;
export declare function createRemoteRuntimeDir(machine: HerdrMachineReference, runId: string, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<string>;
export declare function removeRemoteRuntimeDir(machine: HerdrMachineReference, runtimeDir: string, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
}): void;
/** The single private owner for allocation shared by every pane-native backend projection. */
export declare class HerdrPlacedRunOwner {
    #private;
    readonly machine: HerdrMachineReference;
    readonly runId: string;
    readonly runtimeDir: string;
    connection: HerdrForwardedConnection;
    owned?: {
        workspaceId: string;
        tabId: string;
        paneId: string;
    };
    terminalId?: string;
    agentName?: string;
    startedArgv?: string[];
    identity?: HerdrRunIdentity;
    private constructor();
    static create(machine: HerdrMachineReference, runId: string, beforePane?: (owner: HerdrPlacedRunOwner) => void | Promise<void>): Promise<HerdrPlacedRunOwner>;
    observeEvent(event: unknown): void;
    markConnectionUnknown(observed: HerdrForwardedConnection): boolean;
    statusSubscriptions(paneId?: string | undefined): unknown[];
    subscribe(listener: (event: unknown) => void, disconnected: (error: Error) => void): Promise<void>;
    provision(environment?: Record<string, string>): Promise<{
        workspaceId: string;
        tabId: string;
        paneId: string;
    }>;
    start(kind: "pi" | "claude" | "cursor" | "codex", name: string, args: string[], options?: {
        timeoutMs?: number;
        pollMs?: number;
        clock?: {
            now(): number;
            wait(ms: number): Promise<void>;
        };
    }): Promise<{
        terminalId: string;
        paneId: string;
        argv: string[];
    }>;
    journal(identity: HerdrRunIdentity): void;
    get snapshot(): HerdrRunSnapshot;
    runRemote(command: string, options?: {
        timeout?: number;
        maxBuffer?: number;
    }): import("child_process").SpawnSyncReturns<string>;
    replaceConnection(input: {
        connection: HerdrForwardedConnection;
        unsubscribe: () => void;
        paneId: string;
        state: HerdrRunSnapshot["state"];
    }): Promise<void>;
    cleanup(closeStartedPane?: boolean): Promise<void>;
}
export declare class BridgeChannel {
    #private;
    readonly socket: net.Socket;
    readonly decoder: HerdrPiFrameDecoder;
    readonly listeners: Set<(frame: HerdrPiFrame) => void>;
    readonly waiters: Map<string, {
        resolve(frame: HerdrPiFrame): void;
        reject(error: Error): void;
    }>;
    readonly runId: string;
    readonly frames: HerdrPiFrame[];
    readonly failure: Promise<never>;
    constructor(socketPath: string, runId: string);
    fail(error: Error): void;
    get failed(): boolean;
    wait(type: string, requestId: string): Promise<HerdrPiFrame>;
    configure(resources: {
        agent: string;
        skills?: string[];
        toolCeiling?: string[];
        reads?: string[] | false;
    }): Promise<HerdrPiFrame>;
    supervisorDelivered(requestId: string): void;
    prepare(requestId: string, operation: string, text?: string, supervisorId?: string): Promise<HerdrPiFrame>;
    close(): void;
}
export declare class HerdrPiSession implements ChildSession {
    #private;
    bridgeForward: {
        close(): Promise<void>;
    };
    bridge: BridgeChannel;
    readonly requestedTools: string[] | undefined;
    readonly model: string | undefined;
    readonly supervisorDir: string | undefined;
    readonly runtime: ChildRuntimeConfig;
    readonly owner: HerdrPlacedRunOwner;
    constructor(owner: HerdrPlacedRunOwner, bridgeForward: {
        close(): Promise<void>;
    }, bridge: BridgeChannel, requestedTools: string[] | undefined, model: string | undefined, runtime: ChildRuntimeConfig, initialGit?: HerdrRemoteGitStatus);
    get identity(): HerdrRunIdentity;
    set identity(value: HerdrRunIdentity);
    get connection(): HerdrForwardedConnection;
    set connection(value: HerdrForwardedConnection);
    armReconnect(factory: () => Promise<void>): void;
    get evidenceCursor(): number;
    reconnect(): Promise<void>;
    replaceTransport(input: {
        connection: HerdrForwardedConnection;
        bridgeForward: {
            close(): Promise<void>;
        };
        bridge: BridgeChannel;
        unsubscribe: () => void;
        paneId: string;
        cursor: number;
        state: HerdrRunSnapshot["state"];
    }): Promise<void>;
    observeHerdr(value: unknown): void;
    subscribe(listener: (event: ChildSessionEvent) => void): () => boolean;
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    followUp(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): Promise<void>;
    get messages(): AgentMessage[];
    get sessionFile(): undefined;
    get sessionId(): string;
    get modelId(): string | undefined;
    get machineEvidence(): {
        final?: HerdrRemoteGitStatus | undefined;
        initial?: HerdrRemoteGitStatus | undefined;
        machineId: string;
    };
    get placementSnapshot(): HerdrRunSnapshot;
}
export declare function reconnectHerdrPiSession(session: HerdrPiSession, launch: ChildSessionLaunch, dependencies?: {
    connect?: typeof connectHerdrMachine;
    discoverManifest?: typeof discoverBridgeManifest;
    createBridge?: (socketPath: string, runId: string) => BridgeChannel;
}): Promise<void>;
export declare function createHerdrPiSession(launch: ChildSessionLaunch): Promise<ChildSession>;
export declare function createPlacementAwareChildSessionFactory(local: ChildSessionFactory, createRemote?: (launch: ChildSessionLaunch) => Promise<ChildSession>): ChildSessionFactory;
//# sourceMappingURL=herdr-placed-run.d.ts.map