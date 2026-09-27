import type { AgentConfig } from "./agents.ts";
export declare const KNOWN_FIELDS: Set<string>;
interface SerializeAgentOptions {
    preserveFrontmatterFields?: ReadonlySet<string>;
}
export declare function serializeAgent(config: AgentConfig, options?: SerializeAgentOptions): string;
export {};
//# sourceMappingURL=agent-serializer.d.ts.map