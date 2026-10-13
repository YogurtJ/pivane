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
export declare function formatSavedOutputReference(savedPath: string, fullOutput: string): SavedOutputReference;
/**
 * Keeps at most INLINE_OUTPUT_HEAD_CHARS of a child's output inline and points to the file holding all of it.
 * Files come only from run records, never from the child's text: a trailing `Output saved to:` line is kept as the
 * pointer only when it names the run's recorded saved-output path, and that recorded path is what gets read.
 * Trailing blocks the file does not hold, such as a timed-out child's recovery summary, stay inline after the pointer.
 * Output stays whole when it is short or no readable file contains it, so no text is lost.
 */
export declare function capInlineOutput(output: string, files: {
    artifactPath?: string;
    savedPath?: string;
}): string;
/** Applies capInlineOutput to each `agent:\noutput` section of a run summary whose child output is long. */
export declare function capSummaryOutputs(summary: string, results: ReadonlyArray<{
    agent?: unknown;
    output?: unknown;
    artifactPaths?: {
        outputPath?: unknown;
    };
    artifactOutputSaveFailed?: unknown;
    savedOutputPath?: unknown;
}> | undefined): string;
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
/**
 * Determines whether an output resolution error represents an unrecoverable settlement failure.
 * Returns true for fatal claim-path mismatches in any mode, or when required file-only output
 * fails to persist without a savedPath. Inline and optional outputs remain nonfatal warnings.
 */
export declare function isSettlementFatalOutputError(resolvedOutput: {
    savedPath?: string;
    saveError?: string;
    fatalError?: boolean;
}, outputMode?: OutputMode): boolean;
export {};
//# sourceMappingURL=single-output.d.ts.map