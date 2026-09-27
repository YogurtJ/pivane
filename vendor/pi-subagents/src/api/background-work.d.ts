export declare const BACKGROUND_WORK_PROTOCOL_VERSION = 1;
export declare const BACKGROUND_WORK_REGISTRY_KEY = "pi-subagents.background-work.v1";
export interface BackgroundWorkItem {
    id: string;
    sessionId: string;
}
export interface BackgroundWorkReconcileContext {
    sessionId: string;
    nowMs: number;
}
export interface BackgroundWorkListContext {
    sessionId: string;
    nowMs: number;
}
export interface BackgroundWorkProvider {
    name: string;
    listActiveWork(context?: BackgroundWorkListContext): readonly BackgroundWorkItem[];
    wakeChannels?: readonly string[];
    reconcile?(context: BackgroundWorkReconcileContext): void;
}
export interface RegisteredBackgroundWorkItem extends BackgroundWorkItem {
    provider: string;
}
export interface BackgroundWorkSnapshot {
    providers: readonly string[];
    items: readonly RegisteredBackgroundWorkItem[];
}
/**
 * Register or replace one process-local background-work provider. The returned
 * disposer only removes this exact registration, so an old extension reload
 * cannot unregister its replacement.
 */
export declare function registerBackgroundWorkProvider(provider: BackgroundWorkProvider): () => void;
export declare function listBackgroundWorkProviders(): readonly BackgroundWorkProvider[];
/** Read validated provider wake channels without reconciling or listing work. */
export declare function listBackgroundWorkWakeChannels(): readonly string[];
/** Reconcile and snapshot active provider work owned by one exact Pi session. */
export declare function snapshotBackgroundWork(sessionId: string, nowMs?: number): BackgroundWorkSnapshot;
//# sourceMappingURL=background-work.d.ts.map