import { type Component } from "@earendil-works/pi-tui";
import type { WatchdogWarningDetails } from "./types.ts";
type WatchdogTheme = {
    fg(name: string, value: string): string;
    bold?(value: string): string;
};
export declare function formatWatchdogWarningRenderText(warning: WatchdogWarningDetails): string;
export declare function renderWatchdogWarning(warning: WatchdogWarningDetails, options: {
    expanded: boolean;
}, theme: WatchdogTheme): Component;
export {};
//# sourceMappingURL=render.d.ts.map