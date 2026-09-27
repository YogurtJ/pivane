import type { Message } from "@earendil-works/pi-ai";
import type { OutputMode, SavedOutputReference } from "../../shared/types.ts";
export interface SingleOutputSnapshot {
    exists: boolean;
    mtimeMs?: number;
    size?: number;
    error?: string;
}
/**
 * Content the child itself sent to the configured output path, taken from its
 * last `write` tool call whose tool result reports success. Unlike reading the
 * path from disk, this cannot be polluted by a sibling run writing the same
 * path (#420); requiring the successful tool result keeps failed, cancelled,
 * or unanswered write calls from counting as authored output. Returns
 * undefined when no such write exists (e.g. bash or edit-based construction),
 * in which case callers must not assume file authorship.
 */
export declare function extractChildWrittenOutput(messages: Message[] | undefined, outputPath: string | undefined, cwd?: string): string | undefined;
export declare function normalizeSingleOutputOverride(output: string | boolean | undefined, defaultOutput: string | undefined): string | false | undefined;
export declare function resolveSingleOutputPath(output: string | boolean | undefined, runtimeCwd: string, requestedCwd?: string, relativeBaseDir?: string): string | undefined;
interface OutputInstructionCapabilities {
    tools?: string[];
    mcpDirectTools?: string[];
}
export declare function requestedOutputPathFromTask(task: string): string | undefined;
export declare function outputPathMappingFromTask(task: string, savedPath: string | undefined): {
    requestedPath: string;
    savedPath: string;
} | undefined;
export declare function injectSingleOutputInstruction(task: string, outputPath: string | undefined, capabilities?: OutputInstructionCapabilities): string;
export declare function injectOutputPathSystemPrompt(systemPrompt: string, outputPath: string | undefined, capabilities?: OutputInstructionCapabilities): string;
export declare function formatSavedOutputReference(savedPath: string, fullOutput: string): SavedOutputReference;
export declare function validateFileOnlyOutputMode(outputMode: OutputMode | undefined, outputPath: string | undefined, context: string): string | undefined;
export declare function resolveSingleOutputClaimPath(outputPath: string): string;
export declare function captureSingleOutputSnapshot(outputPath: string | undefined): SingleOutputSnapshot | undefined;
export declare function hasSingleOutputChangedSinceSnapshot(outputPath: string | undefined, beforeRun: SingleOutputSnapshot | undefined): boolean | undefined;
export declare function resolveSingleOutput(outputPath: string | undefined, fallbackOutput: string, beforeRun: SingleOutputSnapshot | undefined, expectedClaimPath?: string): {
    fullOutput: string;
    savedPath?: string;
    saveError?: string;
    fatalError?: boolean;
};
export declare function finalizeSingleOutput(params: {
    fullOutput: string;
    truncatedOutput?: string;
    outputPath?: string;
    outputMode?: OutputMode;
    exitCode: number;
    /** Keep the saved-output reference when a post-run acceptance gate rejects an otherwise completed child. */
    preserveSavedOutput?: boolean;
    savedPath?: string;
    outputReference?: SavedOutputReference;
    saveError?: string;
}): {
    displayOutput: string;
    savedPath?: string;
    outputReference?: SavedOutputReference;
    saveError?: string;
};
export {};
//# sourceMappingURL=single-output.d.ts.map