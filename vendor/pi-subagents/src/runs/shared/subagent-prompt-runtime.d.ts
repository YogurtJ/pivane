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
/** The system messages older than `forkedAt`: the prompt and tool state a fork inherited. */
export declare function systemMessagesBefore<T extends {
    role: string;
}>(messages: readonly T[], forkedAt: number): T[];
/** The model that wrote a fork's inherited history. */
export type InheritedModel = {
    provider: string;
    api: string;
    model: string;
};
/** The provider, API and model of the last assistant message older than `forkedAt`. */
export declare function modelBefore(messages: readonly {
    role: string;
}[], forkedAt: number): InheritedModel | undefined;
/**
 * A forked child starts with its parent's history, and Anthropic-style providers cache a request
 * as one prefix: tools, then the system prompt, then the messages. The child's own prompt (its
 * role, tool list and boundary) and its own tools changed that prefix right after the tools, so
 * every fork re-read the parent's whole conversation without the prompt cache.
 *
 * A fork's request now starts exactly as its parent's last one did:
 * - The system messages it inherited (`inherited`, older than `forkedAt`) are sent as they are,
 *   and the child's own ones are dropped. When a `context` handler made Pi collapse the request
 *   into one leading system message, that message is rebuilt from `inherited`.
 * - Every tool the parent declared stays declared, with the parent's definition. A tool only the
 *   child has, or one the child defines differently under the parent's name (a `structured_output`
 *   with its own schema, for example), is declared by one system message at the fork point, so the
 *   model sees the definition the child's tool checks.
 * - The child's instructions (its role sections, the boundary, the tools it can call) go first in
 *   its first own user message, after the inherited history.
 *
 * Only what a request sends changes; the session keeps Pi's own record. Once a compaction in the
 * child left no inherited message, there is no parent prefix to match: the child's own prompt is
 * sent, with the boundary added as a section.
 */
export declare function projectForkRequest<T extends {
    role: string;
}>(messages: T[], inherited: readonly T[], forkedAt: number, options?: {
    boundary?: string;
}): T[];
/**
 * Pi sends the session id in a session-affinity header to Anthropic-style endpoints that ask for
 * one (`compat.sendSessionAffinityHeaders`), and routers use it to keep a session on the upstream
 * that holds its prompt cache. A fork's request starts with its parent's whole cached prefix, so it
 * names its parent's session to be routed to that cache; otherwise a router with several upstreams
 * may send it to one that never saw the parent. Only the header Pi itself sends is changed, and only
 * when the child runs on the model that wrote its inherited history (`parentModel`, the last
 * inherited assistant message): any other model holds no cache of that prefix.
 */
export declare function applyForkSessionAffinity(headers: Record<string, string | null | undefined> | undefined, model: ExtensionContext["model"] | undefined, parentSessionId: string | undefined, parentModel: InheritedModel | undefined): void;
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
