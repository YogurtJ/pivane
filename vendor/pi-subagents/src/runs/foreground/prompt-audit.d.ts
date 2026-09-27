import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ForegroundRunControl } from "../../shared/types.ts";
export type PromptAuditView = "authored" | "runtime" | "effective";
export interface PromptAuditRerunContract {
    params: Record<string, unknown>;
}
export interface LivePromptAudit {
    authoredTask: string;
    runtimeAdditions: string;
    finalEffectivePrompt: string;
    cwd?: string;
    outputPath?: string;
    rerun?: PromptAuditRerunContract;
}
export declare function rewritePromptWithGuidance(input: {
    ctx: ExtensionContext;
    authoredTask: string;
    runtimeAdditions: string;
    finalEffectivePrompt: string;
    guidance: string;
    signal?: AbortSignal;
    streamFn?: StreamFn;
}): Promise<string>;
export declare function registerLivePromptAudit(control: ForegroundRunControl, index: number, authoredTask: string, effectivePrompt: string, metadata?: {
    cwd?: string;
    outputPath?: string;
    rerun?: PromptAuditRerunContract;
}): void;
export declare function updateLiveEffectivePrompt(control: ForegroundRunControl, index: number, effectivePrompt: string): void;
export declare function getLivePromptAudit(control: ForegroundRunControl, index: number): LivePromptAudit | undefined;
export declare function removeLivePromptAudit(control: ForegroundRunControl, index: number): void;
//# sourceMappingURL=prompt-audit.d.ts.map