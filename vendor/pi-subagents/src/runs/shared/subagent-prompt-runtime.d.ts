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
export declare function rewriteSubagentPrompt(prompt: string, options: {
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    fanoutChild?: boolean;
    structuredOutput?: boolean;
}): string;
export declare function rewriteForkCacheProviderRequest(event: BeforeProviderRequestEvent, ctx: Pick<ExtensionContext, "model"> | undefined, forkCacheKey: string | undefined): unknown;
export declare function stripParentOnlySubagentMessages(messages: unknown[], options?: {
    sanitizeToolIds?: boolean;
    preserveFanoutToolHistory?: boolean;
}): unknown[];
export declare function formatSteerMessage(request: SteerRequest): string;
export declare function registerPermissionGate(pi: ExtensionAPI, permissions: ChildPermissions | undefined, childWatchdog: ChildWatchdogConfig | undefined, requestPermission?: (request: WatchdogPermissionRequest) => Promise<WatchdogPermissionResult>): void;
/** Register every child-side hook the prompt runtime owns for one child session. */
export default function registerSubagentPromptRuntime(pi: ExtensionAPI, config?: ChildRuntimeConfig, drainObservation?: import("./readonly-drain-observation.ts").ReadonlyDrainObservation): void;
//# sourceMappingURL=subagent-prompt-runtime.d.ts.map