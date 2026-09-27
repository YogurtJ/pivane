/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Public execution mode: workflow (workflowScript)
 * Toggle: async parameter (default: true; set asyncByDefault:false in config.json to opt out)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "defaultSubagentContext": "fork", "forkContext": { "mode": "pruned", "model": "provider/model" }, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type HerdrStatusRun } from "../integrations/herdr-status.ts";
import { type SubagentState } from "../shared/types.ts";
export { loadConfig, resolveAsyncByDefault } from "./config.ts";
export declare function projectActiveHerdrRuns(state: SubagentState): HerdrStatusRun[];
export default function registerSubagentExtension(pi: ExtensionAPI): void;
//# sourceMappingURL=index.d.ts.map