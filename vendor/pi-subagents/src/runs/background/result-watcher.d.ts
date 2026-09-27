import * as fs from "node:fs";
import { type IntercomEventBus, type ParallelHandoffReference, type SubagentOutputState, type SubagentState } from "../../shared/types.ts";
import type { CompletionNotifier, CompletionNotification } from "./notify.ts";
import type { ResultDeliveryOwnership } from "./result-delivery-ownership.ts";
type ResultWatcherFs = Pick<typeof fs, "existsSync" | "readFileSync" | "unlinkSync" | "readdirSync" | "mkdirSync" | "realpathSync" | "statSync" | "watch">;
type ResultWatcherTimers = {
    setTimeout: typeof setTimeout;
    clearTimeout: typeof clearTimeout;
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
};
type ResultWatcherDeps = {
    fs?: ResultWatcherFs;
    timers?: ResultWatcherTimers;
    notifier?: Pick<CompletionNotifier, "deliver">;
    /** Receives persisted completions before active-session delivery filtering. */
    observeCompletion?: (result: CompletionNotification & {
        runId: string;
    }) => void;
    /** Returns cross-session run ids that the completion observer currently owns. */
    observedCompletionRunIds?: () => Iterable<string>;
    /** Parses a relevant result payload after its lightweight identity check. */
    parseResult?: (raw: string) => ResultFileData;
    /** External grouped-result transport. Disable when native completion notifications own delivery. */
    deliverIntercomResults?: boolean;
    /** Coalesces result-file events. Tests can lower this without changing retry timing. */
    coalesceDelayMs?: number;
    /** Returns true while a durable completion source needs periodic delivery checks. */
    hasDeliveryDemand?: () => boolean;
    /** Control how slow result-index scans are logged. Defaults to \"activity\". */
    resultScanLogging?: "all" | "activity" | "off";
    platform?: NodeJS.Platform;
    /** Shared current/predecessor session ownership used by the notifier. */
    ownership?: Pick<ResultDeliveryOwnership, "owns" | "claimedSessionIds">;
};
type ResultFileChild = {
    agent?: string;
    sessionName?: string;
    output?: string;
    structuredOutput?: unknown;
    structuredOutputPath?: string;
    outputState?: SubagentOutputState;
    error?: string;
    success?: boolean;
    state?: string;
    interrupted?: boolean;
    timedOut?: boolean;
    stopped?: boolean;
    turnBudgetExceeded?: boolean;
    processSignal?: string | null;
    sessionFile?: string;
    artifactPaths?: {
        outputPath?: string;
    };
    outputSaveError?: string;
    artifactOutputSaveFailed?: true;
    intercomTarget?: string;
    children?: unknown;
};
type ResultFileData = CompletionNotification & {
    runId?: string;
    mode?: string;
    results?: ResultFileChild[];
    nestedChildren?: unknown;
    asyncDir?: string;
    intercomTarget?: string;
    parallelHandoff?: ParallelHandoffReference;
    notificationDeliveredAt?: unknown;
};
/**
 * Watches persisted async results for the session currently owned by this
 * runtime. `stopResultWatcher()` revokes ownership before closing resources,
 * so old callbacks can never emit or delete after reload/session replacement.
 */
export declare function createResultWatcher(pi: {
    events: IntercomEventBus;
}, state: SubagentState, resultsDir: string, completionTtlMs: number, deps?: ResultWatcherDeps): {
    startResultWatcher: () => void;
    transitionResultDelivery: () => void;
    primeExistingResults: (options?: {
        triggerTurn?: boolean;
    }) => void;
    refreshResultDelivery: () => void;
    stopResultWatcher: () => void;
};
export {};
//# sourceMappingURL=result-watcher.d.ts.map