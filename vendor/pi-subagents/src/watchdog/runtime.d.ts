import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { computeWatchdogRepoChangeSignature } from "./change-signature.ts";
import { type WatchdogLspDiagnosticsFunction } from "./lsp-diagnostics.ts";
import { type WatchdogRuleViolation } from "./rules.ts";
import { type ResolvedWatchdogConfig, type WatchdogEndpointConfig, type WatchdogLspRuntimeSnapshot, type WatchdogRuntimeStatus, type WatchdogSettingsError, type WatchdogSettingsResult, type WatchdogSettingsSource, type WatchdogWarning, type WatchdogWarningDetails } from "./types.ts";
type ReviewStopReason = "stop" | "error" | "aborted" | "length";
export interface WatchdogReviewResult {
    warnings?: WatchdogWarning[];
    stopReason?: ReviewStopReason;
    /** Provider error text for a failed review, surfaced in status `Last error`. */
    errorMessage?: string;
    clarification?: {
        question: string;
        evidence: string;
    };
}
export interface WatchdogReviewRequest {
    delta: string;
    epoch: number;
    hasScope: boolean;
    reviewId: number;
    config: ResolvedWatchdogConfig;
    emitWarning(warning: WatchdogWarning): boolean;
    allowClarification?: boolean;
    signal?: AbortSignal;
}
export type WatchdogReviewFunction = (request: WatchdogReviewRequest) => Promise<WatchdogReviewResult | void> | WatchdogReviewResult | void;
export interface WatchdogRuntimeSnapshot {
    status: WatchdogRuntimeStatus;
    enabled: boolean;
    config: ResolvedWatchdogConfig;
    configOk: boolean;
    errors: WatchdogSettingsError[];
    sources: WatchdogSettingsSource[];
    bufferedDeltas: number;
    epoch: number;
    activeReviewId?: number;
    sessionOverride?: boolean;
    sessionModelOverride?: Partial<Pick<WatchdogEndpointConfig, "model" | "thinking">>;
    lastWarning?: WatchdogWarningDetails;
    lastError?: string;
    failedReviews: number;
    staleReviews: number;
    reviewConnected: boolean;
    reviewDescription: string;
    boundaryRepeats: number;
    stalemate: boolean;
    reviewTrigger: "turn-delta" | "repo-edits";
    changedPaths?: string[];
    lsp: WatchdogLspRuntimeSnapshot;
}
interface MainWatchdogRuntimeOptions {
    cwd?: string;
    resolveConfig?: (cwd: string, options?: {
        session?: Record<string, unknown>;
    }) => WatchdogSettingsResult;
    review?: WatchdogReviewFunction;
    reviewDescription?: string;
    displayWarning?: (warning: WatchdogWarningDetails, options?: WatchdogWarningSendOptions) => void;
    displayUserWarning?: (warning: WatchdogWarningDetails) => void;
    /** Supplying this main-session delivery capability gates clarification (children omit it). */
    displayClarification?: (content: string) => void;
    reviewChangesOnly?: boolean;
    lspDiagnostics?: WatchdogLspDiagnosticsFunction;
    repoChangeSignature?: typeof computeWatchdogRepoChangeSignature;
}
export type WatchdogWarningSendOptions = {
    deliverAs: "steer";
} | {
    triggerTurn: false;
};
type ContextLike = Pick<ExtensionContext, "cwd"> & {
    signal?: AbortSignal;
};
export declare function boundWatchdogReviewText(text: string, cap?: number): string;
export declare class MainWatchdogRuntime {
    private cwd;
    private readonly resolveConfig;
    private readonly review;
    private readonly reviewConnected;
    private readonly reviewDescription;
    private readonly displayWarning;
    private readonly displayUserWarning;
    private readonly reviewChangesOnly;
    private readonly lspDiagnostics;
    private readonly repoChangeSignature;
    private readonly lspLedger;
    private readonly scope;
    private configResult;
    private sessionOverrideEnabled;
    private sessionModelOverride;
    private status;
    private pendingDeltas;
    private pendingDeltaChars;
    private guard;
    private guardMaxWarnings;
    private epoch;
    private reviewIdCounter;
    private agentEndIdCounter;
    private activeAgentEndId;
    private activeAgentEndAbortController;
    private activeReviewId;
    private activeReviewWarning;
    private reviewing;
    private waitingAtAgentEnd;
    private disposed;
    private includeUserPromptInNextDelta;
    private userPrompt;
    private waiters;
    private lastWarning;
    private lastError;
    private lastReviewInputSignature;
    private turnStartChangeSignature;
    private lastReviewedChangeSignature;
    private currentChangedPaths;
    private lastLspSnapshot;
    private observedRepoEditThisTurn;
    private toolResultsThisRun;
    private midRunReviewing;
    private lastBoundaryIdentity;
    private boundaryRepeats;
    private stalemate;
    private ruleWarningsThisRun;
    private midRunGeneration;
    private activeReviewAbortController;
    private failedReviews;
    private staleReviews;
    private readonly displayClarification;
    private askedThisPrompt;
    private activityTail;
    private activityPending;
    private activityReviewUsed;
    constructor(options?: MainWatchdogRuntimeOptions);
    bindSession(ctx: ContextLike): void;
    refreshConfig(cwd?: string): WatchdogSettingsResult;
    setSessionEnabled(enabled: boolean, cwd?: string): WatchdogRuntimeSnapshot;
    setSessionModel(patch: {
        model?: string | null;
        thinking?: WatchdogEndpointConfig["thinking"] | null;
    }, cwd?: string): WatchdogRuntimeSnapshot;
    clearSessionModel(cwd?: string): WatchdogRuntimeSnapshot;
    clearSessionOverride(cwd?: string): WatchdogRuntimeSnapshot;
    reset(_reason?: string, options?: {
        clearReviewInputSignature?: boolean;
        resetChangeSignature?: boolean;
        clearLspLedger?: boolean;
        clearScope?: boolean;
        clearActivity?: boolean;
    }): void;
    dispose(): void;
    handleBeforeAgentStart(event: unknown, ctx: ContextLike): void;
    handleTurnEnd(event: unknown, ctx: ContextLike, structuredTerminal?: boolean): void;
    enqueueDelta(delta: string): void;
    handleToolResult(ctx: ContextLike): void;
    handleAgentEnd(_event: unknown, ctx: ContextLike): Promise<void>;
    displayRuleWarning(violation: WatchdogRuleViolation): void;
    displayRecordedWarning(warning: WatchdogWarning): void;
    getSnapshot(cwd?: string): WatchdogRuntimeSnapshot;
    /** A real mid-stream user input can steer without emitting before_agent_start. */
    handleUserInput(): void;
    handleModelChange(): void;
    waitForIdle(timeoutMs?: number): Promise<boolean>;
    private isEnabled;
    private abortActiveAgentEnd;
    private isAgentEndCurrent;
    private isCurrent;
    private warningMeetsThreshold;
    private routeWarning;
    private acceptWarning;
    private displayBoundaryWarning;
    private invalidateActiveReview;
    private reviewMidRunDelta;
    private cancelMidRunReview;
    private reviewDelta;
    private displayAcceptedReviewWarning;
    private deliverBoundaryWarning;
    private repeatableBoundaryIdentity;
    private resetBoundaryRepeats;
    private currentRepoChangeSignature;
    private resetRepoChangeBaseline;
    private resolveReviewChangeSignature;
    private collectLspDiagnostics;
    private lspSnapshot;
    private appendBoundedDelta;
    private buildReviewInput;
    private scopeBlock;
    private clearPendingDeltas;
    private clearActivity;
    private fail;
    private markLastWarningStale;
    private isSettled;
    private waitForSettled;
    private resolveWaiters;
}
export {};
//# sourceMappingURL=runtime.d.ts.map