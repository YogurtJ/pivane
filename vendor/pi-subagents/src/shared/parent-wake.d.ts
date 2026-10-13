import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export declare const PARENT_WAKE_TEXT = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
export interface ParentWake {
    /**
     * pi.sendMessage, except that a turn-triggering message to an idle parent is appended and the
     * turn is started with sendUserMessage. Pi starts a sendMessage-triggered run without
     * before_agent_start (earendil-works/pi#5581), so that run drops every hook-set prompt section.
     * Returns true when the message was appended that way: Pi emits no extension message_start for it.
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
export declare function createParentWake(pi: Pick<ExtensionAPI, "sendMessage" | "sendUserMessage">, now?: () => number): ParentWake;
//# sourceMappingURL=parent-wake.d.ts.map