/**
 * Per-agent persistent memory scopes with read-only fallback.
 *
 * An agent definition may opt into a durable, role-specific memory scope via the
 * `memory` frontmatter field (e.g. `memory: { scope: "project", path:
 * "security-reviewer" }`). The first lines of a `MEMORY.md` file in the resolved
 * memory directory are injected into the child system prompt so recurring custom
 * agents can recall accumulated role notes. Agents without write tools receive a
 * read-only memory block instead.
 *
 * Memory directories live under a dedicated `agent-memory/` namespace so they
 * never collide with the owner's `~/.pi/agent/memory/{project}/` system.
 */
import { type AgentConfig, type AgentMemoryConfig } from "./agents.ts";
export declare const AGENT_MEMORY_DIR_NAME = "agent-memory";
export declare const AGENT_MEMORY_FILE = "MEMORY.md";
export declare const MAX_MEMORY_LINES = 200;
/** Parse a `memory` frontmatter block string into a typed config, or undefined if invalid. */
export declare function parseMemoryFrontmatter(raw: string | undefined): AgentMemoryConfig | undefined;
/** Whether an agent can write files this run (inherits default builtins when `tools` is unset). */
export declare function agentHasWriteTools(agent: Pick<AgentConfig, "tools">): boolean;
/**
 * Resolve a memory directory under `rootDir` for the given scoped path.
 *
 * Rejects empty paths, `.`/`..` segments, paths that escape the root, and
 * existing directories whose real path (via symlink) lands outside the root.
 */
export declare function resolveMemoryDir(rootDir: string, scopedPath: string): {
    dir: string;
} | {
    error: string;
};
type MemoryFileResult = {
    contents: string;
    byteCapped: boolean;
} | "unsafe" | null;
/** Read `MEMORY.md` under `memoryDir`. Returns null when absent, `"unsafe"` for a symlink. */
export declare function readMemoryFile(memoryDir: string): MemoryFileResult;
/**
 * Build the memory block to append to a child system prompt.
 *
 * Returns an empty string when the agent has no memory scope, the scope cannot
 * be resolved safely, or a read-only agent has no memory file yet (nothing to
 * recall). Read-write agents always receive the scope block so they can create
 * the memory file on the first run.
 */
export declare function buildAgentMemoryInjection(agent: AgentConfig, cwd: string): string;
export {};
//# sourceMappingURL=agent-memory.d.ts.map