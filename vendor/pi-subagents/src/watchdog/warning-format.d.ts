import { type WatchdogWarning, type WatchdogWarningDetails, type WatchdogWarningMessage } from "./types.ts";
export declare function normalizeWatchdogWarningDetails(warning: WatchdogWarning, extras?: Partial<WatchdogWarningDetails>): WatchdogWarningDetails;
export declare function formatWatchdogWarningContent(warning: WatchdogWarning): string;
export declare function createWatchdogWarningMessage(warning: WatchdogWarning, options?: {
    display?: boolean;
    details?: Partial<WatchdogWarningDetails>;
}): WatchdogWarningMessage;
//# sourceMappingURL=warning-format.d.ts.map