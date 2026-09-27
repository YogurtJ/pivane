import type { Message, Usage as PiUsage } from "@earendil-works/pi-ai";
import type { AgentProgress, AsyncStatus, Details, DisplayItem, ErrorInfo, SingleResult, ToolCallSummary, Usage } from "./types.ts";
export declare const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";
export declare const PROMPT_REDACTED = "[prompt redacted]";
export declare function resolveWatchPath(watchPath: string, nativeRealpath?: (filePath: string) => string): string;
export declare function resolveConfigDirName(codingAgentModule?: unknown, entryPoint?: string, packageRoot?: string): string;
export declare function getConfigDirName(): string;
export declare function getProjectConfigDir(projectRoot: string): string;
export declare function getAgentDir(): string;
export declare function pruneStatusCacheForAsyncRoot(asyncDirRoot: string, runIds: Iterable<string>): number;
export declare function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string;
/**
 * Read async job status from disk (with mtime-based caching)
 */
export declare function readStatus(asyncDir: string): AsyncStatus | null;
export declare function getLastActivity(outputFile: string | undefined): string;
export declare function findLatestSessionFile(sessionDir: string): string | null;
export declare function getFinalOutput(messages: Message[]): string;
export declare function getSingleResultOutput(result: Pick<SingleResult, "finalOutput" | "messages">): string;
/**
 * Extract display items (text and tool calls) from messages
 */
export declare function getDisplayItems(messages: Message[] | undefined): DisplayItem[];
export declare function sumResultsUsage(results: SingleResult[]): Usage;
export declare function toAgentToolUsage(usage: Usage): PiUsage;
/** Sum input tokens, output tokens, and cost across a set of SingleResults. */
export declare function sumResultsCost(results: SingleResult[]): NonNullable<Details["totalCost"]>;
export declare function compactForegroundResult(result: SingleResult): SingleResult;
export declare function compactForegroundDetails(details: Details): Details;
/**
 * Streaming counterparts to compactForegroundResult / compactCompletedProgress.
 *
 * The completed-compaction helpers above bail out while a child is still
 * `running`, so a long or deeply nested fan-out streams full, unbounded progress on
 * every tick. The parent records every streamed `tool_execution_update` in its
 * transcript and `events.jsonl`, so an unbounded running snapshot grows those
 * artifacts and the live display state without bound.
 *
 * These bound the STREAMED snapshot only. The final returned result keeps the full
 * live progress and message transcript, and every live-display consumer already
 * reads just the last few entries (`recentTools.slice(-3)`, `recentOutput.slice(-5)`).
 */
export declare const MAX_STREAMED_RECENT_TOOLS = 32;
export declare const MAX_STREAMED_TOOL_CALLS = 64;
export declare const MAX_STREAMED_OUTPUT_LINE_CHARS = 2000;
/** Keep only the most recent tool-history entries in a streamed snapshot. */
export declare function boundStreamedRecentTools(recentTools: AgentProgress["recentTools"]): AgentProgress["recentTools"];
/** Cap per-line length of recent output so one long line can't inflate a snapshot. */
export declare function boundStreamedRecentOutput(recentOutput: string[]): string[];
/**
 * Compact tool-call summaries for a streamed snapshot, standing in for the
 * unbounded `messages` transcript. Prefers an existing `toolCalls` summary, else
 * derives one from `messages`; bounded to the most recent calls.
 */
export declare function boundStreamedToolCalls(result: Pick<SingleResult, "toolCalls" | "messages">): ToolCallSummary[] | undefined;
export declare function hasEmptyTerminalAssistantResponse(messages: Message[]): boolean;
export declare function formatEmptyTerminalAssistantResponseError(messages: Message[]): string;
/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export declare function detectSubagentError(messages: Message[]): ErrorInfo;
/**
 * Extract a preview of tool arguments for display
 */
export declare function extractToolArgsPreview(args: Record<string, unknown>): string;
/**
 * Extract text content from various message content formats
 */
export declare function extractTextFromContent(content: unknown): string;
export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
//# sourceMappingURL=utils.d.ts.map