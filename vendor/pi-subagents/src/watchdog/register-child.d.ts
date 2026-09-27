import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MainWatchdogRuntime } from "./runtime.ts";
import { type ChildWatchdogConfig, type ChildWatchdogStatusEvent } from "./child-status.ts";
import { type ResolvedWatchdogConfig } from "./types.ts";
export declare function childResolvedConfig(config: ChildWatchdogConfig): ResolvedWatchdogConfig;
/**
 * Register the child-side watchdog. Status events go to the sink the hosting
 * process passed in the child runtime config; the host folds them into the
 * child's event stream.
 */
export declare function registerChildWatchdog(pi: ExtensionAPI, childConfig: ChildWatchdogConfig | undefined, writeStatus: ((event: ChildWatchdogStatusEvent) => void) | undefined, structuredTerminal?: {
    captured: boolean;
}): MainWatchdogRuntime | undefined;
//# sourceMappingURL=register-child.d.ts.map