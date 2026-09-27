import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { type ControlEvent, type SubagentState } from "../../shared/types.ts";
interface AsyncJobTrackerOptions {
    completionRetentionMs?: number;
    /** Slow safety sweep for liveness repair when filesystem events are missed. */
    pollIntervalMs?: number;
    resultsDir?: string;
    widgetEnabled?: boolean;
    platform?: NodeJS.Platform;
    onJobTerminal?: () => void;
    watch?: typeof fs.watch;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    /** Resolve native supervisor requests without scanning supervisor mailboxes. */
    supervisorRequestState?: (event: ControlEvent) => "pending" | "resolved" | "unknown";
}
export declare function createAsyncJobTracker(pi: Pick<ExtensionAPI, "events">, state: SubagentState, asyncDirRoot: string, options?: AsyncJobTrackerOptions): {
    ensurePoller: () => void;
    refreshWidget: (ctx: ExtensionContext) => void;
    handleStarted: (data: unknown) => void;
    handleComplete: (data: unknown) => void;
    resetJobs: (ctx?: ExtensionContext) => void;
    restoreActiveJobs: (ctx?: ExtensionContext) => void;
    dispose: () => void;
};
export {};
//# sourceMappingURL=async-job-tracker.d.ts.map