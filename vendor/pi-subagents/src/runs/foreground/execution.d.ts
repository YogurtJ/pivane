/**
 * Core execution logic for running subagents
 */
import { type AgentConfig } from "../../agents/agents.ts";
import { type RunSyncOptions, type SingleResult } from "../../shared/types.ts";
/**
 * Runs the authoritative completion pipeline independently from the foreground
 * receipt. Detachment is same-runtime only: it does not adopt or daemonize work.
 */
export declare function runSync(runtimeCwd: string, agents: AgentConfig[], agentName: string, task: string, options: RunSyncOptions): Promise<SingleResult>;
//# sourceMappingURL=execution.d.ts.map