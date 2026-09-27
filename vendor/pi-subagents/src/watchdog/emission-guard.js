const CONTENT_FREE_PHRASES = new Set([
    "stop",
    "done",
    "complete",
    "completed",
    "no issue",
    "no issues",
    "no concern",
    "no concerns",
    "nothing to add",
    "lgtm",
    "looks good",
    "looks good to me",
    "all good",
    "ok",
    "okay",
    "none",
    "n a",
]);
export function normalizeWatchdogEmissionText(value) {
    return value
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[’'`]/g, "")
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export function watchdogWarningUnderlyingIdentity(warning) {
    return [normalizeWatchdogEmissionText(warning.summary), normalizeWatchdogEmissionText(warning.evidence)].join("\n");
}
export function watchdogWarningIdentity(warning) {
    return [warning.severity, watchdogWarningUnderlyingIdentity(warning)].join("\n");
}
function isContentFree(value) {
    const normalized = normalizeWatchdogEmissionText(value);
    return !normalized || CONTENT_FREE_PHRASES.has(normalized);
}
export class WatchdogEmissionGuard {
    maxWarnings;
    dedupeHistoryLimit;
    acceptedCount = 0;
    acceptedByUnderlyingIdentity = new Map();
    historyOrder = [];
    updateAcceptedUnderlyingIdentity;
    updateAcceptedSeverity;
    constructor(options = {}) {
        this.maxWarnings = options.maxWarnings ?? null;
        this.dedupeHistoryLimit = options.dedupeHistoryLimit ?? 200;
    }
    startModelUpdate() {
        this.updateAcceptedUnderlyingIdentity = undefined;
        this.updateAcceptedSeverity = undefined;
    }
    reset() {
        this.acceptedCount = 0;
        this.acceptedByUnderlyingIdentity.clear();
        this.historyOrder = [];
        this.startModelUpdate();
    }
    /** `allowRepeatOf`: one already-accepted identity that may repeat (boundary re-findings before stalemate). */
    evaluate(warning, options = {}) {
        if (isContentFree(warning.summary) || isContentFree(warning.evidence) || isContentFree(warning.recommendedAction)) {
            return { accepted: false, reason: "content-free" };
        }
        const underlyingIdentity = watchdogWarningUnderlyingIdentity(warning);
        const identity = watchdogWarningIdentity(warning);
        const priorSeverity = this.acceptedByUnderlyingIdentity.get(underlyingIdentity);
        const escalation = priorSeverity === "concern" && warning.severity === "blocker";
        if (this.updateAcceptedUnderlyingIdentity !== undefined) {
            const updateEscalation = this.updateAcceptedUnderlyingIdentity === underlyingIdentity
                && this.updateAcceptedSeverity === "concern"
                && warning.severity === "blocker";
            if (!updateEscalation)
                return { accepted: false, reason: "update-budget", identity, underlyingIdentity };
        }
        const repeat = priorSeverity !== undefined && options.allowRepeatOf === identity;
        if (priorSeverity !== undefined && !escalation && !repeat)
            return { accepted: false, reason: "duplicate", identity, underlyingIdentity };
        if (this.maxWarnings !== null && this.acceptedCount >= this.maxWarnings && !escalation && !repeat) {
            return { accepted: false, reason: "max-warnings", identity, underlyingIdentity };
        }
        this.acceptedByUnderlyingIdentity.set(underlyingIdentity, warning.severity);
        if (!priorSeverity) {
            this.acceptedCount++;
            this.historyOrder.push(underlyingIdentity);
        }
        while (this.historyOrder.length > this.dedupeHistoryLimit) {
            const stale = this.historyOrder.shift();
            if (stale)
                this.acceptedByUnderlyingIdentity.delete(stale);
        }
        this.updateAcceptedUnderlyingIdentity = underlyingIdentity;
        this.updateAcceptedSeverity = warning.severity;
        return { accepted: true, identity, underlyingIdentity, escalation };
    }
}
//# sourceMappingURL=emission-guard.js.map