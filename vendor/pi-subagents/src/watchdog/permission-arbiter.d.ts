import { type StreamFn } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
export interface WatchdogPermissionResult {
    approved: boolean;
    reason: string;
    source: "watchdog";
}
export interface WatchdogPermissionRequest {
    ctx: ExtensionContext;
    toolName: string;
    args: unknown;
    rawWatchdogConfig?: string;
    auditPath?: string;
    signal?: AbortSignal;
}
export interface WatchdogPermissionArbiterOptions {
    streamFn?: StreamFn;
}
export declare function createWatchdogPermissionArbiter(options?: WatchdogPermissionArbiterOptions): (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult>;
export declare const requestWatchdogPermission: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult>;
//# sourceMappingURL=permission-arbiter.d.ts.map