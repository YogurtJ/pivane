import type { AgentConfig } from "../../agents/agents.ts";
import type { RunnerLauncher } from "../../shared/types.ts";
/** Own-property lookup, so an inherited object key can never select a command. */
export declare function lookupRunnerLauncher(runnerLaunchers: Record<string, string[]> | undefined, name: string): RunnerLauncher | undefined;
/** A launcher wraps the local Pi background runner, so it cannot combine with machine placement or an external runner. */
export declare function runnerLauncherPlacementError(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, machine: string | undefined): string | undefined;
/** The launcher an agent launch runs under, or the reason it cannot launch. */
export declare function resolveAgentRunnerLauncher(agent: Pick<AgentConfig, "name" | "launcher" | "runner">, runnerLaunchers: Record<string, string[]> | undefined, machine: string | undefined): {
    launcher?: RunnerLauncher;
    error?: string;
};
//# sourceMappingURL=runner-launcher.d.ts.map