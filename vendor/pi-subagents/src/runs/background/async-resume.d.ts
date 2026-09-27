import { type AsyncStatus, type SteeringRecoveryDescriptor, type SubagentRunMode } from "../../shared/types.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { type ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import { type ThinkingLevel } from "../../shared/thinking-ceiling.ts";
export interface AsyncResumeParams {
    id?: string;
    runId?: string;
    dir?: string;
    index?: number;
}
export interface AsyncResumeDeps {
    asyncDirRoot?: string;
    resultsDir?: string;
    kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
    now?: () => number;
}
export interface AsyncResumeOptions {
    requireSessionFile?: boolean;
    sessionId?: string;
}
export type AsyncResumeTarget = {
    kind: "live" | "revive";
    runId: string;
    asyncDir?: string;
    state: AsyncStatus["state"];
    mode?: SubagentRunMode;
    agent: string;
    /** Human-readable display name for the child session, when derived at launch. */
    sessionName?: string;
    index: number;
    cwd?: string;
    /** True when cwd is the retained managed worktree recorded by the handoff. */
    managedWorktree?: boolean;
    sessionFile?: string;
    model?: string;
    thinking?: string;
    thinkingCeiling?: ThinkingLevel;
    recoveryDescriptor?: SteeringRecoveryDescriptor;
    capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
    launchContractDigest?: string;
    runner?: NonNullable<AsyncStatus["steps"]>[number]["runner"];
    externalJob?: NonNullable<AsyncStatus["steps"]>[number]["externalJob"];
};
export interface AsyncRunLocation {
    asyncDir: string | null;
    resultPath: string | null;
    resolvedId?: string;
}
export declare function findAsyncRunPrefixMatches(prefix: string, asyncDirRoot: string, resultsDir: string): Array<{
    id: string;
    location: AsyncRunLocation;
}>;
export declare function resolveAsyncRunLocation(params: AsyncResumeParams, asyncDirRoot: string, resultsDir: string): AsyncRunLocation;
export declare function asyncReviveRequiresRecoveryDescriptor(target: Pick<AsyncResumeTarget, "recoveryDescriptor" | "mode" | "sessionFile" | "capabilityCeiling">): boolean;
export declare function readAsyncRecoveryDescriptor(asyncDir: string | undefined): SteeringRecoveryDescriptor | undefined;
export declare function resolveAsyncResumeTarget(params: AsyncResumeParams, deps?: AsyncResumeDeps, options?: AsyncResumeOptions): AsyncResumeTarget;
export declare function applySteeringRecoveryAgentConfig(agentConfig: AgentConfig, descriptor: SteeringRecoveryDescriptor): AgentConfig;
export declare function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string;
//# sourceMappingURL=async-resume.d.ts.map