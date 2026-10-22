/** Ends a waking notice that reports results. */
export const COMPLETION_ACTION = "Read the saved results above and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
/** Ends a waking notice that reports a problem or a run state rather than results. */
export const STATUS_ACTION = "Check the run status and details above, then resume the already-authorized parent task or report the problem. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
// A wake whose run never starts emits no agent_start; past this deadline an idle parent's wake counts as abandoned.
// Pi persists the waking notice only when its run reaches message_end, so a run that never starts loses it;
// notify.ts records undelivered subagent-notify notices at shutdown and replays them at the next start.
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
            if (held || (ctx.isIdle() && reserved())) {
                // Appended now, or at the end of a run still finishing; neither emits an extension message_start.
                // A reserved wake's run picks the notice up when it starts.
                pi.sendMessage(message, { triggerTurn: false });
                return true;
            }
            if (ctx.isIdle())
                reservation().sentAt = now();
            pi.sendMessage(message, options);
            return false;
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
