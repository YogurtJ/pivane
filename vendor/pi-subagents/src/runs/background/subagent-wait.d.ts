/**
 * `bg_wait` tool: block the current turn until outstanding async runs
 * or a named remembered detached foreground run finishes.
 *
 * Background subagent runs are detached. In an interactive session the parent
 * can end its turn and Pi will wake it with a completion notification. That
 * does not work when the parent is a skill that must run to completion, and it
 * cannot work at all non-interactively (`pi -p ...`), where the run is a single
 * turn: once the turn ends there is nothing left to receive the notification.
 *
 * `bg_wait` closes that gap. It keeps the turn alive until a tracked async
 * run for this session reaches a terminal state (complete / failed / paused),
 * the caller-supplied timeout elapses, or the turn is aborted. Because it awaits
 * inside the turn, the completion the model was told to wait for is actually
 * observed before the tool returns.
 *
 * By default `bg_wait` returns as soon as ONE run finishes, so a fleet
 * manager can use it in a rolling-replacement loop: launch N workers, wait for
 * the next one to finish, spawn its replacement, then call `bg_wait`
 * again — keeping N in flight instead of draining to zero between batches.
 * Pass `all: true` to block until every tracked async run is terminal, or `id`
 * to block on one specific async or remembered detached foreground run.
 *
 * `bg_wait` also returns when a run needs attention — not just on
 * completion. A child that goes idle or blocks for a decision surfaces
 * `needs_attention` (the same signal Pi shows as a control notice and,
 * interactively, wakes the parent with). Since `bg_wait` is used exactly
 * where there is no next turn to receive that notice, it must break on it too,
 * or a stuck child would stall the loop until the timeout. Attention runs are
 * reported so the caller can inspect / nudge / resume / interrupt them.
 *
 * Wake mechanism: when given Pi's event bus (`deps.events`), `bg_wait`
 * subscribes to the subagent completion/control channels and wakes the instant
 * any fires, rather than waiting out a fixed poll interval. A poll still runs
 * on the interval as a reconciliation fallback (crashed runners, missed
 * events), and the poll is the source of truth for what actually changed — the
 * event only ends the sleep early. With no bus, `bg_wait` degrades to pure
 * polling.
 */
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type BackgroundWorkSnapshot } from "../../api/background-work.ts";
import { type Details, type SubagentState } from "../../shared/types.ts";
export { WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV, WAIT_TOOL_ENABLED_ENV, resolveWaitToolConfig, type ResolvedWaitToolConfig } from "./wait-config.ts";
export interface SubagentWaitParams {
    /** Optional run id/prefix to wait for. When omitted, waits across every active run in this session. */
    id?: string;
    /** Arm a durable exact-run wake subscription and return immediately. Requires id. */
    nonBlocking?: boolean;
    /**
     * When true, block until EVERY active run in this session (or matching `id`)
     * is terminal. Default false: return when the first tracked run or provider
     * item finishes or needs attention. Ignored when `id` targets a single run.
     */
    all?: boolean;
    /** Give up after this many milliseconds. Defaults to waitTool.defaultTimeoutMs, then 30 minutes. */
    timeoutMs?: number;
    /** False keeps a blocking wait open through idle attention; supervisor/contact requests still stop the wait. */
    stopOnAttention?: boolean;
}
/** Minimal event-bus surface wait subscribes to (matches pi.events). */
export interface WaitEventBus {
    on(channel: string, handler: (data: unknown) => void): () => void;
}
export interface SubagentWaitDeps {
    state: SubagentState;
    /** Stream live wait status into Pi's pending tool row. */
    onUpdate?: (result: AgentToolResult<Details>) => void;
    asyncDirRoot?: string;
    resultsDir?: string;
    /** Root from the child's validated inherited route, not a tool argument. */
    nestedRootRunId?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
    pollIntervalMs?: number;
    /** False makes the tool return immediately without blocking active async runs. */
    enabled?: boolean;
    /** Configured blocking window used when the call omits timeoutMs. */
    defaultTimeoutMs?: number;
    /** Injectable sleep for tests. */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    /** Internal auto-drain mode waits through needs-attention states. */
    stopOnAttention?: boolean;
    /** Internal auto-drain mode surfaces failed terminal subagent runs as errors. */
    failOnFailedRuns?: boolean;
    /** Internal auto-drain mode surfaces actionable attention as an error. */
    failOnAttention?: boolean;
    /** Durable owned supervisor-request barrier used by headless auto-drain. */
    hasPendingSupervisorRequest?: () => boolean;
    /** Arm a durable exact-target wait subscription in a long-lived interactive runtime. */
    subscribe?: (input: {
        targetKind: "async" | "foreground";
        runId: string;
        requestedId: string;
        timeoutMs: number;
    }) => {
        token: string;
        expiresAt: number;
    };
    /** Injectable provider protocol surfaces for deterministic tests. */
    backgroundWork?: {
        snapshot(sessionId: string, nowMs: number): BackgroundWorkSnapshot;
        wakeChannels(): readonly string[];
    };
    /**
     * Optional event bus (pi.events). When provided, wait wakes immediately on a
     * subagent completion/control event instead of waiting out the poll interval;
     * the poll then remains as a reconciliation fallback (crashed runners, missed
     * events). Omit in tests that want pure poll behavior.
     */
    events?: WaitEventBus;
}
export declare function waitRunScopes(deps: Pick<SubagentWaitDeps, "asyncDirRoot" | "resultsDir" | "nestedRootRunId">): Array<{
    asyncDirRoot: string;
    resultsDir: string;
}>;
/**
 * Block until the targeted async or remembered detached foreground run finishes,
 * the timeout elapses, or the turn is aborted. Resolves with a short
 * human-readable summary either way.
 */
export declare function waitForSubagents(params: SubagentWaitParams, signal: AbortSignal | undefined, deps: SubagentWaitDeps): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=subagent-wait.d.ts.map