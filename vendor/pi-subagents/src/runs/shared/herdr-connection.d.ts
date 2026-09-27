import type { HerdrMachineReference } from "../../shared/types.ts";
export declare const HERDR_REMOTE_PATH = "$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
export declare const HERDR_SSH_BASE: readonly ["-T", "-o", "BatchMode=yes", "-o", "NumberOfPasswordPrompts=0", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", "-o", "ConnectionAttempts=1", "-o", "ForwardAgent=no", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", "-o", "SendEnv=-*", "-o", "SetEnv=PI_SUBAGENTS_SSH_GUARD="];
export declare function hardenedSshEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function herdrSshArgs(source?: NodeJS.ProcessEnv): string[];
export interface HerdrEndpoint {
    socket: string;
    session: string | null;
    version: string;
    protocol: number;
    compatible: boolean;
    running: boolean;
}
export interface HerdrRpcClient {
    call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void>;
}
export declare class HerdrRpcError extends Error {
    readonly code?: string;
    readonly requestId: string;
    constructor(message: string, requestId: string, code?: string);
}
export declare class HerdrTransportError extends Error {
    constructor(message: string, options?: ErrorOptions);
}
export interface HerdrForwardedConnection {
    endpoint: HerdrEndpoint;
    socketPath: string;
    client: HerdrRpcClient;
    forwardRemoteSocket(remotePath: string, name: string): Promise<{
        socketPath: string;
        close(): Promise<void>;
    }>;
    close(): Promise<void>;
}
export declare function decodeHerdrJsonLine(line: Buffer): unknown;
export declare function shellQuoteRemote(value: string): string;
export declare function remoteShellCommand(script: string, args?: string[]): string;
export declare function runHerdrRemoteCommand(machine: HerdrMachineReference, command: string, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
}): import("child_process").SpawnSyncReturns<string>;
export declare function runHerdrRemoteCommandAsync(machine: HerdrMachineReference, command: string, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    maxBuffer?: number;
}): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}>;
export declare function parseHerdrEndpoint(value: string, expectedSession?: string): HerdrEndpoint;
export declare function discoverHerdrEndpoint(machine: HerdrMachineReference, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<HerdrEndpoint>;
export declare class SocketRpcClient implements HerdrRpcClient {
    #private;
    constructor(socketPath: string, subscriptionAckTimeoutMs?: number);
    call<T>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
    subscribe(subscriptions: unknown[], listener: (event: unknown) => void, onDisconnect?: (error: Error) => void): Promise<() => void>;
}
export declare function connectHerdrMachine(machine: HerdrMachineReference, options?: {
    sshBin?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<HerdrForwardedConnection>;
//# sourceMappingURL=herdr-connection.d.ts.map