import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { type Details } from "../shared/types.ts";
export interface SlashSubagentResponse {
    requestId: string;
    result: AgentToolResult<Details>;
    isError: boolean;
    errorText?: string;
}
export interface SlashSubagentUpdate {
    requestId: string;
    progress?: Details["progress"];
    currentTool?: string;
    toolCount?: number;
}
interface EventBus {
    on(event: string, handler: (data: unknown) => void): (() => void) | void;
    emit(event: string, data: unknown): void;
}
interface SlashBridgeOptions {
    events: EventBus;
    getContext: () => ExtensionContext | null;
    execute: (id: string, params: SubagentParamsLike, signal: AbortSignal, onUpdate: ((r: AgentToolResult<Details>) => void) | undefined, ctx: ExtensionContext) => Promise<AgentToolResult<Details>>;
}
export declare function registerSlashSubagentBridge(options: SlashBridgeOptions): {
    cancelAll: () => void;
    dispose: () => void;
};
export {};
//# sourceMappingURL=slash-bridge.d.ts.map