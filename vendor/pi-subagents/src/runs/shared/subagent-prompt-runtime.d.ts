import type { BeforeProviderRequestEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SteerRequest } from "../background/control-channel.ts";
import type { ChildWatchdogConfig } from "../../watchdog/child-status.ts";
import { type WatchdogPermissionRequest, type WatchdogPermissionResult } from "../../watchdog/permission-arbiter.ts";
import { type ChildPermissions, type ChildRuntimeConfig } from "./child-runtime-config.ts";
export declare const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS: string;
export declare const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS: string;
export declare function stripProjectContext(prompt: string): string;
export declare function stripGlobalContext(prompt: string): string;
export declare function stripInheritedSkills(prompt: string): string;
export declare function stripSubagentOrchestrationSkill(prompt: string): string;
type InheritedPromptOptions = {
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
};
type ChildBoundaryOptions = {
    fanoutChild?: boolean;
    structuredOutput?: boolean;
};
export declare function rewriteSubagentPrompt(prompt: string, options: InheritedPromptOptions & ChildBoundaryOptions): string;
/** Installed after every other extension: a returned prompt freezes out sections added after it. */
export declare function registerSubagentPromptBoundary(pi: ExtensionAPI, config: ChildRuntimeConfig): void;
type DeclaredTool = {
    name: string;
};
/** The tools the system messages older than `forkedAt` declare, replayed in order as Pi does. */
export declare function toolsDeclaredBefore(messages: readonly {
    role: string;
}[], forkedAt: number): DeclaredTool[];
/**
 * A forked child starts with its parent's history, whose system messages declare the parent's
 * tools, and its own first system message removes the tools this child may not use. Providers
 * cache the tool list before everything else, so that removal made every request of a fork miss
 * the parent's prompt cache. Requests now keep declaring every `inherited` tool, in its order,
 * before the tools the child adds: the child's own system messages (written at or after
 * `forkedAt`) lose their removals of those tools. When a `context` handler changed the
 * conversation, Pi sends one leading system message holding the current tools instead, and that
 * message's tools are set to the same list. The child still does not register the tools it may
 * not use, so a call to one gets Pi's "not found" error and runs nothing. Only what a request
 * sends changes; the session keeps Pi's own record. Once a compaction in the child left no
 * inherited message in the request, there is no parent prefix to match, and nothing changes.
 */
export declare function keepInheritedToolDeclarations<T extends {
    role: string;
}>(messages: T[], inherited: readonly DeclaredTool[], forkedAt: number): T[];
export declare function rewriteForkCacheProviderRequest(event: BeforeProviderRequestEvent, ctx: Pick<ExtensionContext, "model"> | undefined, forkCacheKey: string | undefined): unknown;
/**
 * `inheritedBefore`, set in a forked child to the fork's time, keeps the history the child
 * inherited as the parent sent it, so its requests can reuse the parent's prompt cache; only tool
 * ids are still made portable there. The child cannot run `subagent` either way.
 */
export declare function stripParentOnlySubagentMessages(messages: unknown[], options?: {
    sanitizeToolIds?: boolean;
    preserveBoundedCompositeToolIds?: boolean;
    preserveFanoutToolHistory?: boolean;
    inheritedBefore?: number;
}): unknown[];
export declare function formatSteerMessage(request: SteerRequest): string;
export declare function registerPermissionGate(pi: ExtensionAPI, permissions: ChildPermissions | undefined, childWatchdog: ChildWatchdogConfig | undefined, requestPermission?: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult>): void;
/** Register every child-side hook the prompt runtime owns for one child session. */
export default function registerSubagentPromptRuntime(pi: ExtensionAPI, config?: ChildRuntimeConfig, drainObservation?: import("./readonly-drain-observation.ts").ReadonlyDrainObservation): void;
export {};
//# sourceMappingURL=subagent-prompt-runtime.d.ts.map