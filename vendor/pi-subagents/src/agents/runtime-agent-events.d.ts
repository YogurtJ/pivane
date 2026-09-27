import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type RuntimeAgentDefinition, type RuntimeAgentRegistration } from "./runtime-agent-registry.ts";
export declare const RUNTIME_AGENT_REGISTER_EVENT = "pi-subagents:runtime-agent-register:v1";
export declare const RUNTIME_AGENT_REGISTER_VERSION = 1;
export type RuntimeAgentRegistrationResult = {
    ok: true;
    registration: RuntimeAgentRegistration;
} | {
    ok: false;
    error: Error;
};
export interface RuntimeAgentRegistrationRequest {
    version: 1;
    name: string;
    definition: RuntimeAgentDefinition;
    result?: RuntimeAgentRegistrationResult;
}
export interface RegisterRuntimeAgentViaEventsInput {
    pi: Pick<ExtensionAPI, "events">;
    name: string;
    definition: RuntimeAgentDefinition;
}
/** Register through the installed pi-subagents owner in this Pi process. */
export declare function registerAgentViaEvents(input: RegisterRuntimeAgentViaEventsInput): RuntimeAgentRegistration;
/** Install the process-local registration listener for the owning pi-subagents runtime. */
export declare function registerRuntimeAgentEventListener(pi: ExtensionAPI): () => void;
//# sourceMappingURL=runtime-agent-events.d.ts.map