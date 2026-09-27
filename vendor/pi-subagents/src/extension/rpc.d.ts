import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { type Details, type SubagentState, type TokenUsage } from "../shared/types.ts";
export declare const SUBAGENT_RPC_PROTOCOL_VERSION = 1;
export declare const SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request";
export declare const SUBAGENT_RPC_READY_EVENT = "subagents:rpc:v1:ready";
export declare const SUBAGENT_RPC_REPLY_EVENT_PREFIX = "subagents:rpc:v1:reply:";
export declare const SUBAGENT_RPC_METHODS: readonly ["ping", "status", "manage", "spawn", "steer", "interrupt", "stop", "resume", "cost"];
export type SubagentRpcMethod = typeof SUBAGENT_RPC_METHODS[number];
export interface SubagentRpcRequestEnvelope {
    version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
    requestId: string;
    method: SubagentRpcMethod;
    params?: unknown;
    source?: {
        extension?: string;
        [key: string]: unknown;
    };
}
export type SubagentRpcReplyEnvelope<T = unknown> = {
    version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
    requestId: string;
    method?: SubagentRpcMethod;
    success: true;
    data: T;
} | {
    version: typeof SUBAGENT_RPC_PROTOCOL_VERSION;
    requestId: string;
    method?: SubagentRpcMethod;
    success: false;
    error: {
        code: SubagentRpcErrorCode;
        message: string;
    };
};
export declare const SUBAGENT_RPC_MANAGEMENT_ACTIONS: readonly ["schedule.list", "schedule.show", "schedule.history", "schedule.pause", "schedule.resume", "schedule.run", "schedule.delete"];
type SubagentRpcErrorCode = "invalid_request" | "invalid_params" | "unsupported_version" | "unsupported_method" | "no_active_session" | "execution_failed" | "not_found" | "invalid_state";
interface EventBus {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}
export interface SubagentRpcFleetEntry {
    /** Opaque key for client-side reconciliation; never a run or async identifier. */
    key: string;
    /** Resolved child agent/role name. */
    agent: string;
    role?: string;
    model?: string;
    effort?: string;
    startedAt: number;
    tokens: TokenUsage;
    goal?: string;
}
export interface SubagentRpcFleetStatus {
    version: 1;
    entries: SubagentRpcFleetEntry[];
    /** Total active children before the bounded entries window. */
    totalActive: number;
    topLevelAsyncCapacity: {
        used: number;
        limit: number;
    };
    omitted: number;
}
interface RegisterSubagentRpcBridgeOptions {
    events: EventBus;
    getContext: () => ExtensionContext | null;
    execute: (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((result: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
    asyncDirRoot?: string;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    /** Native live state, projected into the optional public fleet-status capability. */
    state?: SubagentState;
}
export declare function subagentRpcReplyEvent(requestId: string): string;
export declare function registerSubagentRpcBridge(options: RegisterSubagentRpcBridgeOptions): {
    emitReady: (ctx?: ExtensionContext | null) => void;
    dispose: () => void;
};
export {};
//# sourceMappingURL=rpc.d.ts.map