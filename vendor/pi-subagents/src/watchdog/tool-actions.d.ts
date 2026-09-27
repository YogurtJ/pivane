import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Details } from "../shared/types.ts";
import type { MainWatchdogRuntime } from "./runtime.ts";
interface WatchdogToolParams {
    action?: string;
    scope?: string;
    target?: string;
    agent?: string;
    model?: string;
    thinking?: string | false;
    cwd?: string;
}
export declare function handleWatchdogToolAction(action: string, params: WatchdogToolParams, ctx: ExtensionContext, runtime?: MainWatchdogRuntime): AgentToolResult<Details>;
export declare const WATCHDOG_TOOL_ACTIONS: readonly ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"];
export declare const WATCHDOG_THINKING_VALUES: readonly ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
export {};
//# sourceMappingURL=tool-actions.d.ts.map