import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForkContextConfig } from "./types.ts";
declare const RECOVERY_VERSION = 1;
type OverflowKind = "tool-result" | "tool-call" | "assistant-text" | "assistant-thinking" | "user-text" | "summary-text";
export interface PrunedForkRecoveryRecord {
    sourceEntryId: string;
    itemId: string;
    kind: OverflowKind;
    label: string;
    body: string;
    bodyDigest: string;
    utf8Bytes: number;
    utf16CodeUnits: number;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    startByte?: number;
    endByte?: number;
}
export interface PrunedForkRecoveryPayload {
    version: typeof RECOVERY_VERSION;
    batchId: string;
    parentSession: string;
    sourceHeadEntryId: string;
    records: PrunedForkRecoveryRecord[];
}
type SummaryFunction = (payload: string) => Promise<string>;
interface PruneForkOptions {
    validateRecovery?: (payload: PrunedForkRecoveryPayload) => boolean;
}
export declare function prunedForkRecoveryPath(sessionFile: string): string;
export declare function pruneForkSessionFile(sessionFile: string, summarize: SummaryFunction, options?: PruneForkOptions): Promise<boolean>;
export declare function createPrunedForkSessionWriter(ctx: Pick<ExtensionContext, "modelRegistry" | "model">, config: ForkContextConfig | undefined, signal?: AbortSignal): Promise<(sessionFile: string) => Promise<void>>;
export {};
//# sourceMappingURL=pruned-fork.d.ts.map