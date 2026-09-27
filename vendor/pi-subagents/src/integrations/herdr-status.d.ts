export interface HerdrStatusBridgeEvents {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}
export interface HerdrStatusRun {
    id: string;
    agent?: string;
    agents?: string[];
    /** Explicit launch/workflow label only; raw prompts never enter pane metadata. */
    taskLabel?: string;
    needsAttention?: boolean;
    attentionLabel?: string;
}
export interface HerdrStatusBridgeOptions {
    events: HerdrStatusBridgeEvents;
    env?: Record<string, string | undefined>;
    /** Current authoritative active-run projection, used before TTL refresh. */
    getRuns?: () => Iterable<HerdrStatusRun>;
    /** Current project panes opened by this Pi session. Views are excluded. */
    getProjectPaneCount?: () => number;
    runHerdr: (args: readonly string[]) => void | Promise<void>;
    ttlMs?: number;
    refreshMs?: number;
    timers?: {
        setInterval: typeof setInterval;
        clearInterval: typeof clearInterval;
    };
}
export interface HerdrStatusBridge {
    /**
     * Binds the pane owner. Only the root interactive session may publish pane
     * metadata: headless parents (print/json), non-UI harnesses, and child
     * runtimes must never fight the pane's lifecycle authority over display
     * state. Also re-syncs runs that survived a reload/resume.
     */
    sessionStarted(input: {
        hasUI: boolean;
        runs: Iterable<HerdrStatusRun>;
    }): void;
    syncRuns(): void;
    agentStarted(): void;
    flush(): Promise<void>;
    dispose(): void;
}
export declare function registerHerdrStatusBridge(options: HerdrStatusBridgeOptions): HerdrStatusBridge;
//# sourceMappingURL=herdr-status.d.ts.map