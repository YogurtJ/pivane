import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type SubagentState, type WaitSubscriptionRecord } from "../../shared/types.ts";
export interface ArmWaitSubscriptionInput {
    targetKind: "async" | "foreground";
    runId: string;
    requestedId: string;
    timeoutMs: number;
}
export interface WaitSubscriptionManager {
    start(): void;
    arm(input: ArmWaitSubscriptionInput): WaitSubscriptionRecord;
    restore(): void;
    reconcile(): void;
    dispose(): void;
}
interface WaitSubscriptionManagerOptions {
    asyncDirRoot?: string;
    resultsDir?: string;
    subscriptionsDir?: string;
    now?: () => number;
    pollIntervalMs?: number;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
}
export declare function formatWaitSubscriptions(state: Pick<SubagentState, "waitSubscriptions">, now?: number): string | undefined;
export declare function createWaitSubscriptionManager(pi: Pick<ExtensionAPI, "events" | "sendMessage">, state: SubagentState, options?: WaitSubscriptionManagerOptions): WaitSubscriptionManager;
export {};
//# sourceMappingURL=wait-subscriptions.d.ts.map