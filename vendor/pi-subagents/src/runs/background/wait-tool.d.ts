import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SubagentState } from "../../shared/types.ts";
import type { WaitSubscriptionManager } from "./wait-subscriptions.ts";
export declare function registerWaitTool(pi: ExtensionAPI, state: SubagentState, enabled?: boolean, subscriptions?: Pick<WaitSubscriptionManager, "arm">, defaultTimeoutMs?: number, child?: {
    nestedRootRunId?: string;
}, hasPendingSupervisorRequest?: () => boolean): void;
//# sourceMappingURL=wait-tool.d.ts.map