import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import type { SlashSubagentResponse, SlashSubagentUpdate } from "./slash-bridge.ts";
import { type Details } from "../shared/types.ts";
export interface SlashMessageDetails {
    requestId: string;
    result: AgentToolResult<Details>;
}
interface SlashSnapshot {
    result: AgentToolResult<Details>;
    version: number;
}
export declare function buildSlashInitialResult(requestId: string, params: SubagentParamsLike): SlashMessageDetails;
export declare function applySlashUpdate(requestId: string, update: SlashSubagentUpdate): void;
export declare function finalizeSlashResult(response: SlashSubagentResponse): SlashMessageDetails;
export declare function failSlashResult(requestId: string, params: SubagentParamsLike, message: string): SlashMessageDetails;
export declare function resolveSlashMessageDetails(value: unknown): SlashMessageDetails | undefined;
export declare function getSlashRenderableSnapshot(details: SlashMessageDetails): SlashSnapshot;
export declare function restoreSlashFinalSnapshots(entries: unknown[]): void;
export declare function clearSlashSnapshots(): void;
export {};
//# sourceMappingURL=slash-live-state.d.ts.map