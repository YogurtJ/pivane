/**
 * Child lifecycle projection: when the observed child session events mean
 * the run is settling and the observer may start (or must cancel) its final
 * drain window.
 */
export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";
export interface ChildLifecycleState {
    compactionRetryActive: boolean;
}
export declare function projectChildLifecycle(event: {
    type?: string;
    willRetry?: unknown;
}, terminalAssistantStop?: boolean, state?: ChildLifecycleState): ChildLifecycleAction;
//# sourceMappingURL=child-lifecycle.d.ts.map