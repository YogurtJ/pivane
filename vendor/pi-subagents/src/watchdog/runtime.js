import { createHash } from "node:crypto";
import { computeWatchdogRepoChangeSignature, eventIndicatesRepoEdit } from "./change-signature.js";
import { WatchdogEmissionGuard } from "./emission-guard.js";
import { collectWatchdogLspDiagnostics, formatWatchdogLspDiagnosticsBlock, WatchdogLspDiagnosticsLedger, watchdogWarningFromLspDiagnostics, } from "./lsp-diagnostics.js";
import { ruleViolationWarning } from "./rules.js";
import { WatchdogScopeArtifact } from "./scope.js";
import { resolveWatchdogConfig } from "./settings.js";
import { formatWatchdogOrchestrationActivity, formatWatchdogTurnDelta } from "./turn-delta.js";
import { WATCHDOG_WARNING_IMPORTANCES, } from "./types.js";
import { normalizeWatchdogWarningDetails } from "./warning-format.js";
const DEFAULT_REVIEW = () => ({ warnings: [] });
const MAX_REVIEW_INPUT_CHARS = 24_000;
const REVIEW_INPUT_HEAD_CHARS = 6_000;
const REVIEW_DELTA_SEPARATOR = "\n\n---\n\n";
export function boundWatchdogReviewText(text, cap = MAX_REVIEW_INPUT_CHARS) {
    if (text.length <= cap)
        return text;
    const head = Math.min(REVIEW_INPUT_HEAD_CHARS, Math.floor(cap / 4));
    const marker = `\n\n[... about ${text.length - cap} characters omitted ...]\n\n`;
    return `${text.slice(0, head)}${marker}${text.slice(text.length - (cap - head - marker.length))}`;
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function promptFromBeforeAgentStart(event) {
    if (!event || typeof event !== "object")
        return undefined;
    const input = event;
    if (typeof input.prompt === "string")
        return input.prompt;
    if (typeof input.systemPrompt === "string")
        return input.systemPrompt;
    return undefined;
}
function reviewInputSignature(input) {
    return createHash("sha256").update(input).digest("hex");
}
export class MainWatchdogRuntime {
    cwd;
    resolveConfig;
    review;
    reviewConnected;
    reviewDescription;
    displayWarning;
    displayUserWarning;
    reviewChangesOnly;
    lspDiagnostics;
    repoChangeSignature;
    lspLedger = new WatchdogLspDiagnosticsLedger();
    scope = new WatchdogScopeArtifact();
    configResult;
    sessionOverrideEnabled;
    sessionModelOverride;
    status = "idle";
    pendingDeltas = [];
    pendingDeltaChars = 0;
    guard = new WatchdogEmissionGuard();
    guardMaxWarnings = null;
    epoch = 0;
    reviewIdCounter = 0;
    agentEndIdCounter = 0;
    activeAgentEndId;
    activeAgentEndAbortController;
    activeReviewId;
    activeReviewWarning;
    reviewing = false;
    waitingAtAgentEnd = false;
    disposed = false;
    includeUserPromptInNextDelta = false;
    userPrompt;
    waiters = [];
    lastWarning;
    lastError;
    lastReviewInputSignature;
    turnStartChangeSignature;
    lastReviewedChangeSignature;
    currentChangedPaths;
    lastLspSnapshot;
    observedRepoEditThisTurn = false;
    toolResultsThisRun = 0;
    midRunReviewing = false;
    lastBoundaryIdentity;
    boundaryRepeats = 0;
    stalemate = false;
    ruleWarningsThisRun = new Set();
    midRunGeneration = 0;
    activeReviewAbortController;
    failedReviews = 0;
    staleReviews = 0;
    displayClarification;
    askedThisPrompt = false;
    activityTail = "";
    activityPending = false;
    activityReviewUsed = false;
    constructor(options = {}) {
        this.cwd = options.cwd ?? process.cwd();
        this.resolveConfig = options.resolveConfig ?? resolveWatchdogConfig;
        this.review = options.review ?? DEFAULT_REVIEW;
        this.reviewConnected = Boolean(options.review);
        this.reviewDescription = options.reviewDescription ?? (options.review ? "injected seam" : "not wired");
        this.displayWarning = options.displayWarning;
        this.displayUserWarning = options.displayUserWarning;
        this.displayClarification = options.displayClarification;
        this.reviewChangesOnly = options.reviewChangesOnly === true;
        this.lspDiagnostics = options.lspDiagnostics ?? collectWatchdogLspDiagnostics;
        this.repoChangeSignature = options.repoChangeSignature ?? computeWatchdogRepoChangeSignature;
        this.configResult = this.resolveConfig(this.cwd);
        this.guardMaxWarnings = this.configResult.config.maxWarnings;
        this.guard = new WatchdogEmissionGuard({ maxWarnings: this.guardMaxWarnings });
        this.turnStartChangeSignature = this.currentRepoChangeSignature();
        this.lastReviewedChangeSignature = this.turnStartChangeSignature?.key;
    }
    bindSession(ctx) {
        this.cwd = ctx.cwd;
        this.sessionOverrideEnabled = undefined;
        this.sessionModelOverride = undefined;
        this.refreshConfig(ctx.cwd);
        this.reset("session_start", { clearReviewInputSignature: true, resetChangeSignature: true, clearLspLedger: true, clearScope: true });
        this.resetBoundaryRepeats();
    }
    refreshConfig(cwd = this.cwd) {
        this.cwd = cwd;
        const wasEnabled = this.isEnabled();
        const hadClarification = this.configResult.config.clarification;
        const previousMain = this.configResult.config.main;
        const session = this.sessionOverrideEnabled === undefined && this.sessionModelOverride === undefined
            ? undefined
            : {
                ...(this.sessionOverrideEnabled === undefined ? {} : { enabled: this.sessionOverrideEnabled }),
                main: {
                    ...(this.sessionOverrideEnabled === undefined ? {} : { enabled: this.sessionOverrideEnabled }),
                    ...(this.sessionModelOverride ?? {}),
                },
            };
        this.configResult = this.resolveConfig(this.cwd, session === undefined ? undefined : { session });
        if (this.configResult.config.maxWarnings !== this.guardMaxWarnings) {
            this.guardMaxWarnings = this.configResult.config.maxWarnings;
            this.guard = new WatchdogEmissionGuard({ maxWarnings: this.guardMaxWarnings });
        }
        if (wasEnabled && !this.isEnabled())
            this.invalidateActiveReview("watchdog disabled");
        if (!this.isEnabled() || !this.configResult.config.clarification)
            this.clearActivity();
        if (this.displayClarification && (hadClarification || this.configResult.config.clarification) && (this.reviewing || this.waitingAtAgentEnd)) {
            if (!this.configResult.config.clarification || previousMain.model !== this.configResult.config.main.model || previousMain.thinking !== this.configResult.config.main.thinking)
                this.invalidateActiveReview("clarification configuration changed");
        }
        return this.configResult;
    }
    setSessionEnabled(enabled, cwd = this.cwd) {
        this.sessionOverrideEnabled = enabled;
        this.reset("session override");
        this.refreshConfig(cwd);
        return this.getSnapshot();
    }
    setSessionModel(patch, cwd = this.cwd) {
        const next = { ...(this.sessionModelOverride ?? {}) };
        if (patch.model === null)
            delete next.model;
        else if (patch.model !== undefined)
            next.model = patch.model;
        if (patch.thinking === null)
            delete next.thinking;
        else if (patch.thinking !== undefined)
            next.thinking = patch.thinking;
        this.sessionModelOverride = next.model === undefined && next.thinking === undefined ? undefined : next;
        this.reset("session model override");
        this.refreshConfig(cwd);
        return this.getSnapshot();
    }
    clearSessionModel(cwd = this.cwd) {
        this.sessionModelOverride = undefined;
        this.reset("session model override cleared");
        this.refreshConfig(cwd);
        return this.getSnapshot();
    }
    clearSessionOverride(cwd = this.cwd) {
        this.sessionOverrideEnabled = undefined;
        this.sessionModelOverride = undefined;
        this.reset("session override cleared");
        this.refreshConfig(cwd);
        return this.getSnapshot();
    }
    reset(_reason = "reset", options = {}) {
        this.activeReviewAbortController?.abort();
        this.abortActiveAgentEnd();
        this.epoch++;
        this.status = "idle";
        this.clearPendingDeltas();
        this.reviewing = false;
        this.waitingAtAgentEnd = false;
        this.activeReviewId = undefined;
        this.activeReviewWarning = undefined;
        this.includeUserPromptInNextDelta = false;
        this.userPrompt = undefined;
        this.lastError = undefined;
        this.currentChangedPaths = undefined;
        this.observedRepoEditThisTurn = false;
        this.toolResultsThisRun = 0;
        this.midRunReviewing = false;
        this.ruleWarningsThisRun.clear();
        if (options.clearLspLedger) {
            this.lspLedger.reset();
            this.lastLspSnapshot = undefined;
        }
        if (options.clearScope)
            this.scope.reset();
        if (options.clearScope || options.clearActivity)
            this.clearActivity();
        if (options.clearReviewInputSignature)
            this.lastReviewInputSignature = undefined;
        if (options.resetChangeSignature)
            this.resetRepoChangeBaseline({ reviewed: true });
        this.guard.reset();
        this.resolveWaiters(true);
    }
    dispose() {
        this.clearActivity();
        this.activeReviewAbortController?.abort();
        this.disposed = true;
        this.abortActiveAgentEnd();
        this.epoch++;
        this.status = "idle";
        this.clearPendingDeltas();
        this.reviewing = false;
        this.waitingAtAgentEnd = false;
        this.activeReviewId = undefined;
        this.activeReviewWarning = undefined;
        this.lastReviewInputSignature = undefined;
        this.currentChangedPaths = undefined;
        this.lastLspSnapshot = undefined;
        this.lspLedger.reset();
        this.scope.reset();
        this.observedRepoEditThisTurn = false;
        this.toolResultsThisRun = 0;
        this.midRunReviewing = false;
        this.resolveWaiters(false);
    }
    handleBeforeAgentStart(event, ctx) {
        if (this.disposed)
            return;
        const incomingPrompt = promptFromBeforeAgentStart(event);
        this.reset("before_agent_start");
        this.askedThisPrompt = false;
        this.activityReviewUsed = false;
        this.resetBoundaryRepeats();
        this.refreshConfig(ctx.cwd);
        this.userPrompt = incomingPrompt;
        if (this.userPrompt?.trim()) {
            this.includeUserPromptInNextDelta = true;
            this.scope.addPrompt(this.userPrompt);
        }
        else {
            this.includeUserPromptInNextDelta = false;
        }
        this.resetRepoChangeBaseline();
    }
    handleTurnEnd(event, ctx, structuredTerminal = false) {
        if (this.disposed)
            return;
        this.refreshConfig(ctx.cwd);
        if (!this.isEnabled())
            return;
        try {
            if (this.displayClarification && this.configResult.config.clarification && this.boundaryRepeats === 0) {
                const activity = formatWatchdogOrchestrationActivity(event);
                if (activity) {
                    this.activityTail = [this.activityTail, boundWatchdogReviewText(activity, 3_000)].filter(Boolean).join(REVIEW_DELTA_SEPARATOR).slice(-6_000);
                    this.activityPending = true;
                }
            }
            this.observedRepoEditThisTurn ||= eventIndicatesRepoEdit(event);
            const delta = formatWatchdogTurnDelta({
                includeUserPrompt: this.includeUserPromptInNextDelta,
                userPrompt: this.userPrompt,
                events: [event],
                structuredTerminal,
            });
            this.includeUserPromptInNextDelta = false;
            this.enqueueDelta(delta);
        }
        catch (error) {
            this.fail(`Failed to format watchdog turn delta: ${errorMessage(error)}`);
        }
    }
    enqueueDelta(delta) {
        if (this.disposed || !delta.trim() || !this.isEnabled())
            return;
        this.appendBoundedDelta(delta);
        if (!this.reviewing && !this.waitingAtAgentEnd && !this.midRunReviewing)
            this.status = "queued";
    }
    handleToolResult(ctx) {
        if (this.disposed)
            return;
        this.refreshConfig(ctx.cwd);
        if (!this.isEnabled())
            return;
        const everyNTools = this.configResult.config.cadence.everyNTools;
        if (everyNTools === null)
            return;
        this.toolResultsThisRun++;
        if (this.toolResultsThisRun % everyNTools !== 0)
            return;
        if (this.reviewing || this.waitingAtAgentEnd || this.midRunReviewing)
            return;
        const delta = this.buildReviewInput(undefined, "");
        if (!delta.trim())
            return;
        void this.reviewMidRunDelta(delta);
    }
    async handleAgentEnd(_event, ctx) {
        if (this.disposed)
            return;
        this.refreshConfig(ctx.cwd);
        if (!this.isEnabled())
            return;
        if (ctx.signal?.aborted)
            return;
        const changeSignature = this.resolveReviewChangeSignature(this.currentRepoChangeSignature(ctx.cwd), ctx.cwd);
        const activityReview = Boolean(this.displayClarification && this.configResult.config.clarification && !this.activityReviewUsed && this.boundaryRepeats === 0 && this.activityPending);
        const knownEvidence = changeSignature && changeSignature.key === this.lastReviewedChangeSignature;
        if (!activityReview && (knownEvidence || (this.reviewChangesOnly && !changeSignature))) {
            this.clearPendingDeltas();
            if (knownEvidence || this.status === "queued")
                this.status = "idle";
            this.resolveWaiters(true);
            return;
        }
        this.cancelMidRunReview();
        if (activityReview && (!changeSignature || knownEvidence))
            this.activityReviewUsed = true;
        this.activityPending = false;
        this.waitingAtAgentEnd = true;
        const agentEndEpoch = this.epoch;
        const agentEndId = ++this.agentEndIdCounter;
        const lspAbortController = new AbortController();
        this.activeAgentEndId = agentEndId;
        this.activeAgentEndAbortController = lspAbortController;
        try {
            this.guard.startModelUpdate();
            const lspBlock = await this.collectLspDiagnostics(changeSignature, {
                epoch: agentEndEpoch,
                agentEndId,
                signal: lspAbortController.signal,
            });
            if (this.activeAgentEndAbortController === lspAbortController)
                this.activeAgentEndAbortController = undefined;
            if (!this.isAgentEndCurrent(agentEndEpoch, agentEndId))
                return;
            const delta = this.buildReviewInput(changeSignature, lspBlock);
            this.clearPendingDeltas();
            if (!delta.trim()) {
                this.waitingAtAgentEnd = false;
                if (this.status === "queued")
                    this.status = "idle";
                this.resolveWaiters(true);
                return;
            }
            const signature = reviewInputSignature(delta);
            if (!this.reviewChangesOnly && signature === this.lastReviewInputSignature) {
                this.waitingAtAgentEnd = false;
                this.status = "idle";
                this.resolveWaiters(true);
                return;
            }
            const outcome = await this.reviewDelta(delta, this.configResult.config.agentEndTimeoutMs, { allowClarification: true });
            if (!this.isAgentEndCurrent(agentEndEpoch, agentEndId))
                return;
            this.waitingAtAgentEnd = false;
            if (outcome === "timeout") {
                this.staleReviews++;
                this.invalidateActiveReview("agent-end timeout");
                this.status = "stale";
                this.markLastWarningStale();
                this.resolveWaiters(true);
                return;
            }
            if ((outcome === "completed" || typeof outcome === "object") && this.status !== "failed" && this.status !== "stale") {
                // A question consumes this evidence just like a completed review, not a pending exchange.
                this.lastReviewInputSignature = signature;
                if (changeSignature)
                    this.lastReviewedChangeSignature = changeSignature.key;
                this.currentChangedPaths = changeSignature?.changedPaths;
                this.status = "idle";
                if (typeof outcome === "object" && !ctx.signal?.aborted)
                    this.displayClarification?.([
                        "Main watchdog clarification:", outcome.question, `Evidence: ${outcome.evidence}`,
                        "Consider this missing context as you continue the task. This is not approval, permission, or a warning. The reviewer has yielded; no reply or follow-up review is required.",
                    ].join("\n"));
            }
            this.resolveWaiters(true);
        }
        finally {
            if (this.activeAgentEndAbortController === lspAbortController)
                this.activeAgentEndAbortController = undefined;
            if (this.activeAgentEndId === agentEndId)
                this.activeAgentEndId = undefined;
        }
    }
    displayRuleWarning(violation) {
        if (this.disposed || this.ruleWarningsThisRun.has(violation.summary))
            return;
        this.ruleWarningsThisRun.add(violation.summary);
        const details = normalizeWatchdogWarningDetails(ruleViolationWarning(violation), { state: "displayed", displayedAt: new Date().toISOString() });
        this.lastWarning = details;
        this.routeWarning(details, { deliverAs: "steer" });
    }
    displayRecordedWarning(warning) {
        const details = normalizeWatchdogWarningDetails(warning, { state: "displayed", source: warning.source ?? "main" });
        this.lastWarning = details;
        this.routeWarning(details);
    }
    getSnapshot(cwd) {
        if (cwd)
            this.refreshConfig(cwd);
        return {
            status: this.status,
            enabled: this.isEnabled(),
            config: this.configResult.config,
            configOk: this.configResult.ok,
            errors: [...this.configResult.errors],
            sources: [...this.configResult.sources],
            bufferedDeltas: this.pendingDeltas.length,
            epoch: this.epoch,
            ...(this.activeReviewId !== undefined ? { activeReviewId: this.activeReviewId } : {}),
            ...(this.sessionOverrideEnabled !== undefined ? { sessionOverride: this.sessionOverrideEnabled } : {}),
            ...(this.sessionModelOverride !== undefined ? { sessionModelOverride: { ...this.sessionModelOverride } } : {}),
            ...(this.lastWarning ? { lastWarning: this.lastWarning } : {}),
            ...(this.lastError ? { lastError: this.lastError } : {}),
            failedReviews: this.failedReviews,
            staleReviews: this.staleReviews,
            reviewConnected: this.reviewConnected,
            reviewDescription: this.reviewDescription,
            boundaryRepeats: this.boundaryRepeats,
            stalemate: this.stalemate,
            reviewTrigger: this.reviewChangesOnly ? "repo-edits" : "turn-delta",
            ...(this.currentChangedPaths?.length ? { changedPaths: [...this.currentChangedPaths] } : {}),
            lsp: this.lspSnapshot(),
        };
    }
    /** A real mid-stream user input can steer without emitting before_agent_start. */
    handleUserInput() {
        if (this.displayClarification && this.configResult.config.clarification && (this.reviewing || this.waitingAtAgentEnd))
            this.reset("new user input");
    }
    handleModelChange() {
        if (this.displayClarification && this.configResult.config.clarification && (this.reviewing || this.waitingAtAgentEnd))
            this.reset("model changed");
    }
    async waitForIdle(timeoutMs = 1_000) {
        return this.waitForSettled(timeoutMs);
    }
    isEnabled() {
        return this.configResult.ok && this.configResult.config.main.enabled;
    }
    abortActiveAgentEnd() {
        this.activeAgentEndAbortController?.abort();
        this.activeAgentEndAbortController = undefined;
        this.activeAgentEndId = undefined;
    }
    isAgentEndCurrent(epoch, agentEndId) {
        return !this.disposed && this.epoch === epoch && this.activeAgentEndId === agentEndId && this.waitingAtAgentEnd && this.isEnabled();
    }
    isCurrent(epoch, reviewId) {
        return !this.disposed && this.epoch === epoch && this.activeReviewId === reviewId;
    }
    warningMeetsThreshold(warning) {
        return WATCHDOG_WARNING_IMPORTANCES.includes(warning.importance)
            && (this.configResult.config.severityThreshold === "concern" || warning.severity === "blocker");
    }
    routeWarning(details, options) {
        if (details.importance === "high")
            this.displayWarning?.(details, options);
        else
            this.displayUserWarning?.(details);
    }
    acceptWarning(epoch, reviewId, warning) {
        if (!this.isCurrent(epoch, reviewId) || !this.isEnabled() || !this.warningMeetsThreshold(warning))
            return false;
        const decision = this.guard.evaluate(warning, { allowRepeatOf: this.repeatableBoundaryIdentity() });
        if (!decision.accepted)
            return false;
        const details = normalizeWatchdogWarningDetails(warning, {
            state: "candidate",
            source: warning.source ?? "main",
            identity: decision.identity,
        });
        this.lastWarning = details;
        this.activeReviewWarning = details;
        return true;
    }
    displayBoundaryWarning(warning) {
        if (!this.isEnabled() || !this.warningMeetsThreshold(warning))
            return false;
        const decision = this.guard.evaluate(warning, { allowRepeatOf: this.repeatableBoundaryIdentity() });
        if (!decision.accepted)
            return false;
        const details = normalizeWatchdogWarningDetails(warning, {
            state: "displayed",
            source: warning.source ?? "main",
            identity: decision.identity,
            displayedAt: new Date().toISOString(),
        });
        this.deliverBoundaryWarning(details);
        return true;
    }
    invalidateActiveReview(_reason) {
        this.activeReviewAbortController?.abort();
        this.abortActiveAgentEnd();
        this.epoch++;
        this.status = "idle";
        this.clearPendingDeltas();
        this.reviewing = false;
        this.waitingAtAgentEnd = false;
        this.activeReviewId = undefined;
        this.activeReviewWarning = undefined;
    }
    async reviewMidRunDelta(delta) {
        if (this.midRunReviewing || this.reviewing || this.waitingAtAgentEnd || this.disposed)
            return;
        this.midRunReviewing = true;
        const generation = this.midRunGeneration;
        try {
            const outcome = await this.reviewDelta(delta, this.configResult.config.agentEndTimeoutMs, { correction: true });
            if (generation !== this.midRunGeneration)
                return;
            if (outcome === "timeout") {
                this.staleReviews++;
                this.status = "stale";
                this.markLastWarningStale();
            }
        }
        finally {
            if (generation === this.midRunGeneration) {
                this.midRunReviewing = false;
                if (this.status === "reviewing")
                    this.status = this.pendingDeltas.length ? "queued" : "idle";
                this.resolveWaiters(this.isSettled());
            }
        }
    }
    // The agent-end boundary review is authoritative; an in-flight cadence review is superseded.
    cancelMidRunReview() {
        if (!this.midRunReviewing)
            return;
        this.midRunGeneration++;
        this.activeReviewAbortController?.abort();
        this.activeReviewAbortController = undefined;
        this.staleReviews++;
        this.reviewing = false;
        this.midRunReviewing = false;
        this.activeReviewId = undefined;
        this.activeReviewWarning = undefined;
    }
    async reviewDelta(delta, timeoutMs, options = {}) {
        if (this.reviewing || this.disposed)
            return "stale";
        this.reviewing = true;
        const reviewEpoch = this.epoch;
        const reviewId = ++this.reviewIdCounter;
        this.activeReviewId = reviewId;
        this.activeReviewWarning = undefined;
        this.status = "reviewing";
        let timeout;
        const abortController = new AbortController();
        this.activeReviewAbortController = abortController;
        const allowClarification = Boolean(options.allowClarification && this.displayClarification && this.configResult.config.clarification && !this.askedThisPrompt && !this.stalemate);
        const reviewPromise = Promise.resolve().then(() => this.review({
            delta,
            epoch: reviewEpoch,
            reviewId,
            config: this.configResult.config,
            hasScope: this.scopeBlock().trim().length > 0,
            signal: abortController.signal,
            emitWarning: (warning) => this.acceptWarning(reviewEpoch, reviewId, warning),
            ...(allowClarification ? { allowClarification: true } : {}),
        }));
        try {
            const result = await Promise.race([
                reviewPromise,
                new Promise((resolve) => {
                    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
                }),
            ]);
            if (result === "timeout") {
                abortController.abort();
                return "timeout";
            }
            if (!this.isCurrent(reviewEpoch, reviewId))
                return "stale";
            if (!result)
                return "stale";
            if (allowClarification && this.configResult.config.clarification && result.clarification && (!result.stopReason || result.stopReason === "stop") && !this.activeReviewWarning && !result.warnings?.length && !abortController.signal.aborted) {
                const question = result.clarification.question.trim();
                const evidence = result.clarification.evidence.trim();
                if (question && evidence) {
                    this.askedThisPrompt = true;
                    return { question: boundWatchdogReviewText(question, 1_000), evidence: boundWatchdogReviewText(evidence, 2_000) };
                }
            }
            for (const warning of result.warnings ?? [])
                this.acceptWarning(reviewEpoch, reviewId, warning);
            if (result.stopReason && result.stopReason !== "stop") {
                const detail = result.errorMessage?.trim() ? ` ${boundWatchdogReviewText(result.errorMessage.trim(), 600)}` : "";
                this.fail(`Watchdog review ended with stop reason '${result.stopReason}'.${detail}`);
                return "completed";
            }
            this.displayAcceptedReviewWarning(options.correction);
            return "completed";
        }
        catch (error) {
            if (this.isCurrent(reviewEpoch, reviewId)) {
                this.fail(`Watchdog review failed: ${errorMessage(error)}`);
                return "completed";
            }
            return "stale";
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (this.activeReviewAbortController === abortController)
                this.activeReviewAbortController = undefined;
            if (this.epoch === reviewEpoch && this.activeReviewId === reviewId) {
                this.reviewing = false;
                this.activeReviewId = undefined;
                this.activeReviewWarning = undefined;
            }
            this.resolveWaiters(this.isSettled());
        }
    }
    displayAcceptedReviewWarning(correction = false) {
        if (!this.activeReviewWarning)
            return;
        const details = {
            ...this.activeReviewWarning,
            state: "displayed",
            displayedAt: new Date().toISOString(),
        };
        if (correction) {
            this.lastWarning = details;
            this.routeWarning(details, { deliverAs: "steer" });
            return;
        }
        this.deliverBoundaryWarning(details);
    }
    // A displayed boundary warning continues the run; the same identity back from consecutive
    // boundaries means no progress, so it is shown held instead of continuing again.
    deliverBoundaryWarning(details) {
        const identity = details.identity ?? reviewInputSignature([details.severity, details.summary, details.evidence].join("\n"));
        if (this.lastBoundaryIdentity === identity)
            this.boundaryRepeats++;
        else {
            this.lastBoundaryIdentity = identity;
            this.boundaryRepeats = 1;
        }
        const stalemate = this.boundaryRepeats >= this.configResult.config.stalemateRepeats;
        const delivered = stalemate
            ? { ...details, state: "stalemate", stalemateRepeats: this.boundaryRepeats }
            : details;
        this.stalemate = stalemate;
        this.lastWarning = delivered;
        this.routeWarning(delivered, stalemate ? { triggerTurn: false } : undefined);
    }
    // The previous boundary finding is a repeat to count, not a duplicate, until stalemate.
    repeatableBoundaryIdentity() {
        return this.waitingAtAgentEnd && !this.stalemate ? this.lastBoundaryIdentity : undefined;
    }
    resetBoundaryRepeats() {
        this.lastBoundaryIdentity = undefined;
        this.boundaryRepeats = 0;
        this.stalemate = false;
    }
    currentRepoChangeSignature(cwd = this.cwd) {
        return this.reviewChangesOnly && this.isEnabled() ? this.repoChangeSignature(cwd) : undefined;
    }
    resetRepoChangeBaseline(options = {}) {
        this.turnStartChangeSignature = this.currentRepoChangeSignature(options.cwd ?? this.cwd);
        if (options.reviewed)
            this.lastReviewedChangeSignature = this.turnStartChangeSignature?.key;
        else
            this.lastReviewedChangeSignature ??= this.turnStartChangeSignature?.key;
        this.currentChangedPaths = this.turnStartChangeSignature?.changedPaths;
        this.observedRepoEditThisTurn = false;
    }
    resolveReviewChangeSignature(current, cwd) {
        if (!this.reviewChangesOnly)
            return undefined;
        if (current) {
            this.currentChangedPaths = current.changedPaths;
            if (current.key === this.turnStartChangeSignature?.key)
                return undefined;
            if (current.changedPaths.length === 0)
                return undefined;
            return current;
        }
        return this.observedRepoEditThisTurn
            ? { root: cwd, key: `observed-edit:${this.epoch}:${this.reviewIdCounter}:${this.pendingDeltaChars}`, changedPaths: [] }
            : undefined;
    }
    async collectLspDiagnostics(changeSignature, current) {
        const config = this.configResult.config.lsp;
        if (!config.enabled || !changeSignature?.changedPaths.length) {
            this.lastLspSnapshot = {
                enabled: config.enabled,
                status: config.enabled ? "skipped" : "disabled",
                checkedPaths: [],
                skippedPaths: [],
                diagnostics: [],
                diagnosticCount: 0,
                freshDiagnosticCount: 0,
                updatedAt: new Date().toISOString(),
            };
            return "";
        }
        try {
            const raw = await this.lspDiagnostics({
                cwd: this.cwd,
                root: changeSignature.root,
                changedPaths: changeSignature.changedPaths,
                config,
                signal: current.signal,
            });
            if (!this.isAgentEndCurrent(current.epoch, current.agentEndId))
                return "";
            const diagnosticCount = raw.diagnostics.length;
            const fresh = this.lspLedger.reduce(raw);
            this.lastLspSnapshot = {
                ...fresh,
                enabled: true,
                diagnosticCount,
                freshDiagnosticCount: fresh.diagnostics.length,
                updatedAt: new Date().toISOString(),
            };
            const warning = watchdogWarningFromLspDiagnostics(fresh);
            if (warning)
                this.displayBoundaryWarning(warning);
            return formatWatchdogLspDiagnosticsBlock(fresh);
        }
        catch (error) {
            if (!this.isAgentEndCurrent(current.epoch, current.agentEndId))
                return "";
            this.lastLspSnapshot = {
                enabled: true,
                status: "failed",
                checkedPaths: [],
                skippedPaths: changeSignature.changedPaths,
                diagnostics: [],
                diagnosticCount: 0,
                freshDiagnosticCount: 0,
                message: `LSP diagnostics failed: ${errorMessage(error)}`,
                updatedAt: new Date().toISOString(),
            };
            return "";
        }
    }
    lspSnapshot() {
        if (this.lastLspSnapshot)
            return {
                ...this.lastLspSnapshot,
                checkedPaths: [...this.lastLspSnapshot.checkedPaths],
                skippedPaths: [...this.lastLspSnapshot.skippedPaths],
                diagnostics: [...this.lastLspSnapshot.diagnostics],
            };
        const enabled = this.isEnabled() && this.configResult.config.lsp.enabled;
        return {
            enabled,
            status: enabled ? "skipped" : "disabled",
            checkedPaths: [],
            skippedPaths: [],
            diagnostics: [],
            diagnosticCount: 0,
            freshDiagnosticCount: 0,
        };
    }
    appendBoundedDelta(delta) {
        let entry = delta.trim();
        if (!entry)
            return;
        if (entry.length > MAX_REVIEW_INPUT_CHARS)
            entry = boundWatchdogReviewText(entry);
        this.pendingDeltas.push(entry);
        this.pendingDeltaChars += entry.length;
        while (this.pendingDeltas.length > 1 && this.pendingDeltaChars + (this.pendingDeltas.length - 1) * REVIEW_DELTA_SEPARATOR.length > MAX_REVIEW_INPUT_CHARS) {
            const removed = this.pendingDeltas.shift();
            if (removed)
                this.pendingDeltaChars -= removed.length;
        }
    }
    buildReviewInput(changeSignature, lspBlock = "") {
        const input = this.pendingDeltas.join(REVIEW_DELTA_SEPARATOR);
        const scopeBlock = this.scopeBlock();
        const changes = changeSignature?.changedPaths.length
            ? ["Changed repo paths:", ...changeSignature.changedPaths.slice(0, 200).map((file) => `- ${file}`)].join("\n")
            : "";
        const activity = this.activityTail ? `Recent delivered orchestration activity (oldest first; bounded observations, not a task board; waits/holds are not evidence of neglect):\n${this.activityTail}` : "";
        const contextPieces = [scopeBlock, changes, lspBlock, activity].filter(Boolean);
        if (!contextPieces.length)
            return boundWatchdogReviewText(input);
        const maxContextLength = Math.floor(MAX_REVIEW_INPUT_CHARS / 2);
        const maxPieceLength = Math.max(1_000, Math.floor(maxContextLength / contextPieces.length));
        const boundedContext = contextPieces.map((piece) => piece.length > maxPieceLength
            ? piece === activity ? boundWatchdogReviewText(piece, maxPieceLength) : `${piece.slice(0, maxPieceLength - 6)}\n- ...`
            : piece).join(REVIEW_DELTA_SEPARATOR);
        const separatorLength = input ? REVIEW_DELTA_SEPARATOR.length : 0;
        const inputBudget = MAX_REVIEW_INPUT_CHARS - boundedContext.length - separatorLength;
        const boundedInput = inputBudget <= 0 ? "" : boundWatchdogReviewText(input, inputBudget);
        return [boundedContext, boundedInput].filter(Boolean).join(REVIEW_DELTA_SEPARATOR);
    }
    scopeBlock() {
        return this.configResult.config.scope.enabled ? this.scope.render() : "";
    }
    clearPendingDeltas() {
        this.pendingDeltas = [];
        this.pendingDeltaChars = 0;
    }
    clearActivity() {
        if (!this.activityTail)
            return;
        this.activityTail = "";
        this.activityPending = false;
    }
    fail(message) {
        this.failedReviews++;
        this.lastError = message;
        this.status = "failed";
        this.clearPendingDeltas();
        this.resolveWaiters(true);
    }
    markLastWarningStale() {
        if (!this.lastWarning || this.lastWarning.state === "displayed")
            return;
        this.lastWarning = { ...this.lastWarning, stale: true, state: "stale" };
    }
    isSettled() {
        return !this.reviewing && this.pendingDeltas.length === 0;
    }
    waitForSettled(timeoutMs) {
        if (this.isSettled())
            return Promise.resolve(true);
        return new Promise((resolve) => {
            const waiter = {
                resolve,
                timer: setTimeout(() => {
                    this.waiters = this.waiters.filter((entry) => entry !== waiter);
                    resolve(false);
                }, timeoutMs),
            };
            this.waiters.push(waiter);
        });
    }
    resolveWaiters(settled) {
        if (!settled && !this.disposed)
            return;
        const waiters = this.waiters;
        this.waiters = [];
        for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(settled);
        }
    }
}
//# sourceMappingURL=runtime.js.map