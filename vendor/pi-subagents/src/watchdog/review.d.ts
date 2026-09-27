import { type AgentTool, type StreamFn, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, ProviderHeaders } from "@earendil-works/pi-ai";
import { type WatchdogDiffBaseline } from "./diff-tool.ts";
import { type WatchdogReviewFunction } from "./runtime.ts";
import { type ResolvedWatchdogConfig } from "./types.ts";
type WatchdogContextProvider = ExtensionContext | (() => ExtensionContext | undefined);
type RegistryModel = Model<any>;
interface WatchdogReviewAuth {
    apiKey?: string;
    headers?: ProviderHeaders;
    env?: Record<string, string>;
}
export interface WatchdogReviewModelSelection {
    model: RegistryModel;
    thinkingLevel: ThinkingLevel;
    auth: WatchdogReviewAuth;
    explicit: boolean;
}
export interface CreateMainWatchdogReviewOptions {
    streamFn?: StreamFn;
    createReadOnlyTools?: (cwd: string) => AgentTool[];
    getThinkingLevel?: () => ThinkingLevel | undefined;
    diffBaseline?: () => WatchdogDiffBaseline | undefined;
}
export declare function resolveWatchdogReviewModel(ctx: ExtensionContext, config: ResolvedWatchdogConfig, options?: {
    currentThinkingLevel?: ThinkingLevel;
}): Promise<WatchdogReviewModelSelection>;
export declare function formatWatchdogCwdSection(cwd: string): string;
export declare function buildWatchdogSystemPrompt(ctx: Pick<ExtensionContext, "cwd">, options?: {
    hasScope?: boolean;
    guidance?: string;
    hasDiff?: boolean;
}): string;
export declare function createMainWatchdogReview(provider: WatchdogContextProvider, options?: CreateMainWatchdogReviewOptions): WatchdogReviewFunction;
export {};
//# sourceMappingURL=review.d.ts.map