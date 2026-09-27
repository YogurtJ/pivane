import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { WatchdogEndpointConfig } from "./types.ts";
import { type ThinkingLevel } from "../shared/model-info.ts";
export declare const STRONG_WATCHDOG_THINKING: ThinkingLevel;
type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["find"]>;
export interface ResolvedWatchdogModelInput {
    model: string;
    thinking?: ThinkingLevel;
    registryModel: NonNullable<RegistryModel>;
}
export interface WatchdogModelRecommendation {
    source: "configured" | "suggested";
    model: string;
    thinking: ThinkingLevel;
    label: string;
    reason: string;
    registryModel: NonNullable<RegistryModel>;
}
export declare function parseWatchdogThinkingInput(value: string | false | undefined, source?: string): ThinkingLevel | false | undefined;
export declare function resolveWatchdogModelInput(ctx: ExtensionContext, rawModel: string): ResolvedWatchdogModelInput;
export declare function recommendStrongWatchdogModel(ctx: ExtensionContext): WatchdogModelRecommendation;
export declare function recommendWatchdogModel(ctx: ExtensionContext, configured: WatchdogEndpointConfig): WatchdogModelRecommendation;
export declare function formatWatchdogRecommendation(recommendation: WatchdogModelRecommendation): string;
export {};
//# sourceMappingURL=model-selection.d.ts.map