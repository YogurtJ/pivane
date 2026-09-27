import { type AsyncStatus, type SubagentState } from "../../shared/types.ts";
/** On-demand inspection of current-session async children. Re-reads canonical artifacts after the same reconciliation as status; nothing is persisted or broadcast. */
export declare const INSPECT_REPLY_KIND = "pi-subagents.inspect-reply";
export declare const INSPECT_REPLY_VERSION = 1;
export declare const INSPECT_WIDGET_KEY = "subagent-inspect";
export declare const INSPECT_WIDGET_PREFIX = "PI_SUBAGENT_INSPECT_JSON:";
export type InspectErrorCode = "invalid_request" | "not_found" | "foreign_session" | "stale" | "no_active_session" | "internal";
export interface InspectRequest {
    requestId: string;
    asyncId: string;
    childId?: string;
    lines?: number;
}
export interface InspectReplyMessage {
    role: string;
    kind: "text" | "toolCall" | "toolResult";
    text: string;
    name?: string;
    isError?: boolean;
}
export interface InspectReply {
    kind: typeof INSPECT_REPLY_KIND;
    version: typeof INSPECT_REPLY_VERSION;
    requestId: string;
    /** Canonical run id of the inspected node. Absent on error replies that
     *  could not resolve a run. */
    asyncId?: string;
    childId?: string;
    status?: AsyncStatus["state"];
    label?: string;
    task?: string;
    messages?: InspectReplyMessage[];
    finalOutput?: string;
    truncated?: {
        task: boolean;
        messages: number;
        finalOutput: boolean;
    };
    error?: {
        code: InspectErrorCode;
        message: string;
    };
}
export declare const MAX_SERIALIZED_BYTES: number;
export interface InspectDeps {
    state?: SubagentState;
    asyncDirRoot?: string;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
}
export declare function parseInspectRequest(args: string): {
    request?: InspectRequest;
    error?: string;
};
export declare function buildInspectReply(request: InspectRequest, deps?: InspectDeps): InspectReply;
export declare function encodeInspectReply(reply: InspectReply): string[];
/** Parse the slash-command args and always return a correlated inspect reply. */
export declare function handleInspectRpcArgs(args: string, deps?: InspectDeps): InspectReply;
//# sourceMappingURL=inspect-rpc.d.ts.map