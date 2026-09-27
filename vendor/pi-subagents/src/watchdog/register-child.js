import { captureWatchdogDiffBaseline } from "./diff-tool.js";
import { MainWatchdogRuntime } from "./runtime.js";
import { createMainWatchdogReview } from "./review.js";
import { DEFAULT_WATCHDOG_CONFIG } from "./settings.js";
import { createWatchdogWarningMessage } from "./warning-format.js";
import { CHILD_WATCHDOG_STATUS_EVENT, } from "./child-status.js";
import { SUBAGENT_WATCHDOG_WARNING_TYPE } from "./types.js";
export function childResolvedConfig(config) {
    return {
        ...DEFAULT_WATCHDOG_CONFIG,
        enabled: true,
        agentEndTimeoutMs: config.agentEndTimeoutMs,
        maxWarnings: config.maxWarnings,
        main: {
            enabled: true,
            ...(config.model ? { model: config.model } : {}),
            ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
        },
        stalemateRepeats: config.stalemateRepeats,
        cadence: { ...config.cadence },
        children: {
            ...DEFAULT_WATCHDOG_CONFIG.children,
            watchdogTailTimeoutMs: config.watchdogTailTimeoutMs,
        },
        lsp: { ...config.lsp },
    };
}
function childWarningDetails(details, config) {
    return {
        ...details,
        source: details.source === "lsp" ? "lsp" : "child",
        ...(config.agent ? { agent: config.agent } : {}),
        ...(config.runId ? { runId: config.runId } : {}),
    };
}
/**
 * Register the child-side watchdog. Status events go to the sink the hosting
 * process passed in the child runtime config; the host folds them into the
 * child's event stream.
 */
export function registerChildWatchdog(pi, childConfig, writeStatus, structuredTerminal) {
    if (!childConfig)
        return undefined;
    if (!writeStatus)
        throw new Error("Child watchdog status sink is missing; the host must pass ChildRuntimeConfig.watchdogStatus.");
    let currentContext;
    let diffBaseline;
    let agentSettled = false;
    let seq = 0;
    const emitStatus = (phase, reason, warning) => {
        writeStatus({
            type: CHILD_WATCHDOG_STATUS_EVENT,
            ...(childConfig.runId ? { runId: childConfig.runId } : {}),
            ...(childConfig.agent ? { agent: childConfig.agent } : {}),
            ...(childConfig.childIndex !== undefined ? { childIndex: childConfig.childIndex, stepIndex: childConfig.childIndex } : {}),
            seq: ++seq,
            phase,
            ts: Date.now(),
            ...(reason ? { reason } : {}),
            ...(warning ? { warning } : {}),
        });
    };
    const resolved = childResolvedConfig(childConfig);
    const runtime = new MainWatchdogRuntime({
        resolveConfig: () => ({ ok: true, config: resolved, errors: [], sources: [{ scope: "session", exists: true }] }),
        review: createMainWatchdogReview(() => currentContext, { getThinkingLevel: () => pi.getThinkingLevel(), diffBaseline: () => diffBaseline }),
        reviewDescription: "child model review",
        reviewChangesOnly: true,
        displayWarning: (details, options) => {
            const childDetails = childWarningDetails(details, childConfig);
            emitStatus("reviewing", undefined, { severity: childDetails.severity, importance: childDetails.importance, category: childDetails.category, summary: childDetails.summary, evidence: childDetails.evidence, recommendedAction: childDetails.recommendedAction, ...(childDetails.displayedAt ? { displayedAt: childDetails.displayedAt } : {}), addressed: false, stalemate: childDetails.state === "stalemate" });
            const message = createWatchdogWarningMessage(childDetails, { display: true, details: childDetails });
            if (agentSettled)
                pi.appendEntry(SUBAGENT_WATCHDOG_WARNING_TYPE, childDetails);
            else
                pi.sendMessage(message, options);
        },
        displayUserWarning: (details) => {
            const childDetails = childWarningDetails(details, childConfig);
            emitStatus("reviewing", undefined, { severity: childDetails.severity, importance: childDetails.importance, category: childDetails.category, summary: childDetails.summary, evidence: childDetails.evidence, recommendedAction: childDetails.recommendedAction, ...(childDetails.displayedAt ? { displayedAt: childDetails.displayedAt } : {}), addressed: false, stalemate: childDetails.state === "stalemate" });
            pi.appendEntry(SUBAGENT_WATCHDOG_WARNING_TYPE, childDetails);
        },
    });
    const rememberContext = (ctx) => {
        currentContext = ctx;
    };
    const onRuntimeEvent = pi.on;
    onRuntimeEvent("session_start", (_event, ctx) => {
        rememberContext(ctx);
        diffBaseline = captureWatchdogDiffBaseline(ctx.cwd);
        runtime.bindSession(ctx);
        emitStatus("idle");
    });
    onRuntimeEvent("before_agent_start", (event, ctx) => {
        agentSettled = false;
        rememberContext(ctx);
        runtime.handleBeforeAgentStart(event, ctx);
    });
    onRuntimeEvent("turn_end", (event, ctx) => {
        rememberContext(ctx);
        runtime.handleTurnEnd(event, ctx, structuredTerminal?.captured === true);
    });
    onRuntimeEvent("tool_result", (_event, ctx) => {
        rememberContext(ctx);
        runtime.handleToolResult(ctx);
    });
    onRuntimeEvent("agent_end", async (event, ctx) => {
        rememberContext(ctx);
        emitStatus("reviewing");
        await runtime.handleAgentEnd(event, ctx);
        const snapshot = runtime.getSnapshot(ctx.cwd);
        if (snapshot.status === "failed")
            emitStatus("failed", snapshot.lastError);
        else if (snapshot.status === "stale")
            emitStatus("stale", "review stale");
        else
            emitStatus("idle");
    });
    onRuntimeEvent("agent_settled", () => {
        agentSettled = true;
    });
    onRuntimeEvent("session_shutdown", () => {
        currentContext = undefined;
        runtime.dispose();
        emitStatus("idle");
    });
    return runtime;
}
//# sourceMappingURL=register-child.js.map