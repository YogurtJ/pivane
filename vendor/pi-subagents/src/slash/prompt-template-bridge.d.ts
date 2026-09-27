import { type DelegatedSubagentExecutionParams, type PromptTemplateBridgeResult } from "./delegation-adapters.ts";
export declare const PROMPT_TEMPLATE_SUBAGENT_REQUEST_EVENT = "prompt-template:subagent:request";
export declare const PROMPT_TEMPLATE_SUBAGENT_STARTED_EVENT = "prompt-template:subagent:started";
export declare const PROMPT_TEMPLATE_SUBAGENT_RESPONSE_EVENT = "prompt-template:subagent:response";
export declare const PROMPT_TEMPLATE_SUBAGENT_UPDATE_EVENT = "prompt-template:subagent:update";
export declare const PROMPT_TEMPLATE_SUBAGENT_CANCEL_EVENT = "prompt-template:subagent:cancel";
export interface PromptTemplateBridgeEvents {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}
interface PromptTemplateBridgeOptions<Ctx extends {
    cwd?: string;
}> {
    events: PromptTemplateBridgeEvents;
    getContext: () => Ctx | null;
    execute: (requestId: string, params: DelegatedSubagentExecutionParams, signal: AbortSignal, ctx: Ctx, onUpdate: (result: PromptTemplateBridgeResult) => void) => Promise<PromptTemplateBridgeResult>;
    /** Concurrent-safe executor for structured delegation requests. */
    executeStructured?: (requestId: string, params: DelegatedSubagentExecutionParams, signal: AbortSignal, ctx: Ctx, onUpdate: (result: PromptTemplateBridgeResult) => void) => Promise<PromptTemplateBridgeResult>;
}
export declare function registerPromptTemplateDelegationBridge<Ctx extends {
    cwd?: string;
}>(options: PromptTemplateBridgeOptions<Ctx>): {
    cancelAll: () => void;
    dispose: () => void;
};
export {};
//# sourceMappingURL=prompt-template-bridge.d.ts.map