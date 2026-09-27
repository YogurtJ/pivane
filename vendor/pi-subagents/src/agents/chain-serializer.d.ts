import type { ChainConfig } from "./agents.ts";
import type { AgentSource } from "./agents.ts";
export declare function parseChain(content: string, source: AgentSource, filePath: string): ChainConfig;
export declare function parseJsonChain(content: string, source: AgentSource, filePath: string): ChainConfig;
export declare function serializeJsonChain(config: ChainConfig): string;
export declare function serializeChain(config: ChainConfig): string;
//# sourceMappingURL=chain-serializer.d.ts.map