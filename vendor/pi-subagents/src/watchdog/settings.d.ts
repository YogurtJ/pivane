import { type ThinkingLevel } from "../shared/model-info.ts";
import { type ResolvedWatchdogConfig, type WatchdogSettingsResult } from "./types.ts";
export type WatchdogSettingsWriteScope = "user" | "project";
export type WatchdogModelSettingsTarget = {
    kind: "main";
} | {
    kind: "children";
} | {
    kind: "child";
    agent: string;
};
export interface WatchdogModelSettingsWrite {
    scope: WatchdogSettingsWriteScope;
    cwd?: string;
    target: WatchdogModelSettingsTarget;
    model?: string | null;
    thinking?: ThinkingLevel | false | null;
}
export declare const DEFAULT_WATCHDOG_CONFIG: ResolvedWatchdogConfig;
export declare function getWatchdogUserSettingsPath(): string;
export declare function getWatchdogProjectSettingsPath(cwd: string): string;
export declare function resolveWatchdogConfigStrict(cwd: string, options?: {
    session?: Record<string, unknown>;
}): ResolvedWatchdogConfig;
export declare function writeUserWatchdogEnabled(enabled: boolean): string;
export declare function writeWatchdogModelSettings(input: WatchdogModelSettingsWrite): string;
export declare function resolveWatchdogConfig(cwd: string, options?: {
    session?: Record<string, unknown>;
}): WatchdogSettingsResult;
//# sourceMappingURL=settings.d.ts.map