import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
/** Ends a waking notice that reports results. */
export declare const COMPLETION_ACTION = "Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
/** Ends a waking notice that reports a problem or a run state rather than results. */
export declare const STATUS_ACTION = "Check the run status and details above, then resume the already-authorized parent task or report the problem. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
export interface ParentWake {
    /**
     * pi.sendMessage that shares the idle-wake reservation. A turn-triggering message to an idle
     * parent starts the run itself: Pi runs before_agent_start for it and emits its message_start.
     * Returns true when the message was only appended (held, or another wake is already starting
     * the run): Pi emits no extension message_start for it.
     * After userAborted() and until the next run starts, a turn-triggering message is only appended.
     */
    sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>): boolean;
    /** True from an idle wake until its run starts or the session shuts down. Past the deadline it holds only while the parent is busy, which may still be the wake's preflight (for example compacting). */
    isPending(): boolean;
    bindSession(ctx: Pick<ExtensionContext, "isIdle" | "sessionManager">): void;
    agentStarted(): void;
    /** The user stopped the parent run: hold wakes until the next run starts. */
    userAborted(): void;
    /** A deliberate resume (manual compaction) drops the hold without touching the shared wake reservation. */
    releaseHold(): void;
    isHeld(): boolean;
    sessionShutdown(reason: string | undefined): void;
}
export declare function createParentWake(pi: Pick<ExtensionAPI, "sendMessage">, now?: () => number): ParentWake;
