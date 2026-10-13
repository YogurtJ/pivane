export const PARENT_WAKE_TEXT = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
// A handled or failed wake prompt emits no agent_start. Past this deadline an idle parent's
// wake counts as abandoned: its notices are already in the session, only the turn is lost.
const WAKE_PENDING_MS = 10_000;
const reservationsSymbol = Symbol.for("pi.idle-wake.v1");
const wakeGlobal = globalThis;
const reservations = wakeGlobal[reservationsSymbol] ?? (wakeGlobal[reservationsSymbol] = new WeakMap());
export function createParentWake(pi, now = Date.now) {
    let ctx;
    // Captured at bind: Pi's ctx throws once stale, which it can be by session_shutdown.
    let session;
    let held = false;
    // Look the reservation up on every access: another extension may have created this session's entry.
    const reservation = () => {
        // Pi can shut an extension down before session_start binds it; an unbound wake reserved nothing.
        if (!session)
            return { sessionId: "" };
        const current = reservations.get(session.manager);
        if (current?.sessionId === session.id)
            return current;
        const next = { sessionId: session.id };
        reservations.set(session.manager, next);
        return next;
    };
    const reserved = () => {
        const { sentAt } = reservation();
        return sentAt !== undefined && now() - sentAt < WAKE_PENDING_MS;
    };
    return {
        sendMessage(message, options) {
            if (options?.triggerTurn !== true) {
                pi.sendMessage(message, options);
                return false;
            }
            if (held) {
                // Appended now, or at the end of a run still finishing; neither emits an extension message_start.
                pi.sendMessage(message, { triggerTurn: false });
                return true;
            }
            if (!ctx.isIdle()) {
                pi.sendMessage(message, options);
                return false;
            }
            pi.sendMessage(message, { triggerTurn: false });
            if (!reserved()) {
                reservation().sentAt = now();
                // Steer queues the wake if another prompt starts the run first.
                pi.sendUserMessage(PARENT_WAKE_TEXT, { deliverAs: "steer" });
            }
            return true;
        },
        isPending: () => reservation().sentAt !== undefined && (reserved() || !ctx.isIdle()),
        bindSession(context) {
            ctx = context;
            session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
            held = false;
        },
        agentStarted() {
            reservation().sentAt = undefined;
            held = false;
        },
        userAborted: () => { held = true; },
        releaseHold: () => { held = false; },
        isHeld: () => held,
        sessionShutdown(reason) {
            if (reason !== "reload")
                reservation().sentAt = undefined;
        },
    };
}
//# sourceMappingURL=parent-wake.js.map