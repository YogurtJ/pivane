import type { AgentToolResult } from "@earendil-works/pi-agent-core";
/**
 * Convert pi-subagents' internal logical-error result into the rejection Pi's
 * public tool boundary uses to emit a canonical errored ToolResult.
 *
 * Keep this at registered tool boundaries. Internal workflows intentionally
 * retain their return-based error handling.
 */
export declare function finalizeToolResult<T>(result: AgentToolResult<T>): AgentToolResult<T>;
//# sourceMappingURL=tool-result.d.ts.map