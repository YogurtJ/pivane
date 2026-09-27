import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MainWatchdogRuntime, type WatchdogReviewFunction } from "./runtime.ts";
interface RegisterMainWatchdogOptions {
    runtime?: MainWatchdogRuntime;
    review?: WatchdogReviewFunction;
}
export declare function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime["getSnapshot"]>, ctx: ExtensionContext): string;
export declare function registerMainWatchdog(pi: ExtensionAPI, options?: RegisterMainWatchdogOptions): MainWatchdogRuntime;
export {};
//# sourceMappingURL=register-main.d.ts.map