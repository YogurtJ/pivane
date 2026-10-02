/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs use a detached runner process. Unix detaches it from the parent process.
 * The original control path delivered an interrupt with
 * `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
 * deliver those signals cross-process via `process.kill` and throws `ENOSYS`,
 * which left async runs uninterruptible (no stop, no live steer) on Windows.
 *
 * This module adds a portable, file-based control inbox inside the run directory.
 * The parent drops an interrupt request file; the runner watches the inbox and
 * routes the request into its existing graceful `interruptRunner()` (pause +
 * resumable), identically on every platform. The file inbox is authoritative and
 * avoids signaling a PID that the extension cannot prove belongs to the runner.
 */
import * as fs from "node:fs";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
export type ControlChannelFs = Pick<typeof fs, "mkdirSync" | "existsSync" | "rmSync" | "watch" | "readdirSync" | "readFileSync" | "realpathSync">;
export type ControlChannelTimers = {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
};
type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => unknown;
export interface InterruptRequest {
    type: "interrupt";
    ts?: number;
    source?: string;
    reason?: string;
}
export interface TimeoutRequest {
    type: "timeout";
    ts?: number;
    source?: string;
    reason?: string;
}
export interface StopRequest {
    type: "stop";
    ts?: number;
    source?: string;
    reason?: string;
    targetIndex?: number;
    childId?: string;
}
export type SteerDeliveryMode = "steer" | "follow_up" | "auto";
export type SteerDeliveryStatus = "delivered" | "queued";
export interface SteerRequest {
    type: "steer";
    id: string;
    ts: number;
    message: string;
    mode?: SteerDeliveryMode;
    targetIndex?: number;
    targetIndexes?: number[];
    source?: string;
}
export declare const MAX_STEER_QUEUE_SIZE = 20;
/** Control inbox directory inside an async run dir. */
export declare function controlInboxDir(asyncDir: string): string;
/** Path of the portable interrupt request file. */
export declare function interruptRequestPath(asyncDir: string): string;
/** Path of the portable timeout request file. */
export declare function timeoutRequestPath(asyncDir: string): string;
/** Path of the portable manual stop request file. */
export declare function stopRequestPath(asyncDir: string): string;
/** Directory of parent-to-runner stop requests. */
export declare function stopRequestsDir(asyncDir: string): string;
/** Directory of parent-to-runner steering requests. */
export declare function steerRequestsDir(asyncDir: string): string;
export declare function steerInboxClosedPath(asyncDir: string): string;
export declare function stopInboxClosedPath(asyncDir: string): string;
export declare function closeStopInbox(asyncDir: string): void;
export declare function closeSteerInbox(asyncDir: string, state: string, write?: (filePath: string, payload: object) => void): void;
export declare function writeSteerRequestToDir(dir: string, request: SteerRequest): string;
export declare function writeSteerRequestToExistingDir(dir: string, request: SteerRequest): string;
/**
 * Parent side: drop a portable interrupt request the runner's inbox watcher will
 * pick up regardless of OS. Written atomically (temp + rename), dir auto-created.
 */
export declare function requestAsyncInterrupt(asyncDir: string, payload?: Omit<InterruptRequest, "type">, deps?: {
    now?: () => number;
}): string;
export declare function requestAsyncTimeout(asyncDir: string, payload?: Omit<TimeoutRequest, "type">, deps?: {
    now?: () => number;
}): string;
export declare function requestAsyncStop(asyncDir: string, payload?: Omit<StopRequest, "type">, deps?: {
    now?: () => number;
    write?: typeof writeAtomicJson;
}): string;
export declare function requestAsyncSteer(asyncDir: string, payload: {
    message: string;
    mode?: SteerDeliveryMode;
    targetIndex?: number;
    targetIndexes?: number[];
    source?: string;
    id?: string;
    ts?: number;
}, deps?: {
    now?: () => number;
    randomId?: () => string;
}): string;
export declare function consumeSteerRequestsFromDir(dir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync">, onError?: (error: unknown) => void): SteerRequest[];
export declare function consumeSteerRequests(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync">, onError?: (error: unknown) => void): SteerRequest[];
export declare function queueRevivalBrief(asyncDir: string, request: SteerRequest): string;
export declare function readRevivalBriefs(asyncDir: string): Array<{
    request: SteerRequest;
    path: string;
}>;
/**
 * Runner side: consume a pending interrupt request. Idempotent — removes the file
 * so each distinct request fires exactly once. Returns whether one was pending.
 */
export declare function consumeInterruptRequest(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync">): boolean;
export declare function consumeTimeoutRequest(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync">): boolean;
export declare function consumeStopRequest(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync">): boolean;
export declare function consumeStopRequestPayloads(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync">, onError?: (error: unknown) => void): StopRequest[];
export declare function consumeStopRequestPayload(asyncDir: string, fsImpl?: Pick<typeof fs, "existsSync" | "rmSync" | "readdirSync" | "readFileSync">): StopRequest | undefined;
/** Parent side: write the authoritative portable interrupt request. */
export declare function deliverInterruptRequest(input: {
    asyncDir: string;
    now?: () => number;
    source?: string;
}): void;
export declare function deliverTimeoutRequest(input: {
    asyncDir: string;
    pid?: number;
    kill?: KillFn;
    signal?: NodeJS.Signals;
    now?: () => number;
    source?: string;
}): void;
export declare function deliverStopRequest(input: {
    asyncDir: string;
    pid?: number;
    kill?: KillFn;
    signal?: NodeJS.Signals;
    now?: () => number;
    source?: string;
    targetIndex?: number;
    childId?: string;
}): void;
/**
 * Active owner: watch and consume only kinds with installed handlers.
 * Uses `fs.watch` when available and starts interval polling
 * only when native watching is unavailable or fails. Fires once per distinct
 * request. Returns a disposer.
 */
export declare function watchAsyncControlInbox(asyncDir: string, opts: {
    onInterrupt?: () => void;
    onTimeout?: () => void;
    onStop?: (request: StopRequest) => void;
    onSteer?: (request: SteerRequest) => void;
    onError?: (error: unknown, phase: "install" | "scan" | "callback", request?: SteerRequest) => void;
    pollIntervalMs?: number;
    safetyPollIntervalMs?: number;
    platform?: NodeJS.Platform;
    fs?: ControlChannelFs;
    timers?: ControlChannelTimers;
}): () => void;
export {};
//# sourceMappingURL=control-channel.d.ts.map