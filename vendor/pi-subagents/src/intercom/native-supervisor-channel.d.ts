import * as fs from "node:fs";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChildSupervisorMetadata } from "../runs/shared/child-runtime-config.ts";
import type { ParentWake } from "../shared/parent-wake.ts";
import { type ControlEvent, type SubagentState } from "../shared/types.ts";
import { type SupervisorReason } from "./supervisor-ui.ts";
export declare const NATIVE_SUPERVISOR_TOOL_NAME = "subagent_supervisor";
export type SupervisorRequestState = "pending" | "resolved" | "unknown";
interface SupervisorRequest {
    type: "subagent.supervisor.request";
    id: string;
    createdAt: number;
    expiresAt?: number;
    reason: SupervisorReason;
    message: string;
    expectsReply: boolean;
    orchestratorTarget?: string;
    orchestratorSessionId?: string;
    runId: string;
    agent: string;
    childIndex: number;
    toolCallId?: string;
    childTarget?: string;
    interview?: unknown;
}
interface PendingSupervisorRequest extends SupervisorRequest {
    channelDir: string;
    requestFile: string;
}
type SupervisorWatch = (filename: fs.PathLike, listener: fs.WatchListener<string>) => fs.FSWatcher;
interface NativeSupervisorChannelDeps {
    /** Owned live/final-drain mailboxes. Only a completed poll retires the snapshot, never a demand probe. */
    getChannelDirs?: () => {
        dirs: string[];
        retire?: () => void;
    };
    /** Retained scheduled states for the current runtime owner, never foreign owners. */
    getCurrentOwnerStates?: () => Iterable<SubagentState>;
    parentWake?: Pick<ParentWake, "sendMessage">;
    platform?: NodeJS.Platform;
    watch?: SupervisorWatch;
    timers?: Pick<typeof globalThis, "setInterval" | "clearInterval" | "setImmediate" | "clearImmediate">;
}
declare const ContactSupervisorParamsSchema: Type.TObject<{
    reason: Type.TString;
    message: Type.TOptional<Type.TString>;
    interview: Type.TOptional<Type.TUnsafe<unknown>>;
}>;
export declare function resolveSupervisorChannelDir(runId: string, agent: string, childIndex: number): string;
export declare function ensureSupervisorChannelDir(channelDir: string): void;
/**
 * What the model sees of `contact_supervisor`, shared by a child's working tool and the
 * top-level session's refusing one: a forked child's tool list then equals its parent's, so its
 * first request can reuse the parent's prompt cache.
 */
export declare const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
export declare const TOP_LEVEL_SUPERVISOR_REFUSAL = "contact_supervisor works only inside a subagent; this session has no supervisor.";
/** `contact_supervisor` for a session that is not a subagent: every call is an error. */
export declare function topLevelSupervisorTool(): ToolDefinition<typeof ContactSupervisorParamsSchema, Record<string, unknown>>;
/**
 * Register the child-side `contact_supervisor` tool. The host passes the
 * channel metadata in the child runtime config.
 */
export declare function registerNativeSupervisorClient(pi: ExtensionAPI, metadata: ChildSupervisorMetadata | undefined): void;
export declare function createNativeSupervisorChannel(pi: ExtensionAPI, state: SubagentState, deps?: NativeSupervisorChannelDeps): {
    registerTools: () => void;
    start: () => void;
    activateTransport: () => void;
    findPendingAsks: (target: {
        runId: string;
        agent: string;
        childIndex: number;
    }) => string[];
    hasPendingRequests: () => boolean;
    dispose: () => void;
    pending: Map<string, PendingSupervisorRequest>;
    getSupervisorRequestState: (event: ControlEvent) => SupervisorRequestState;
};
export {};
