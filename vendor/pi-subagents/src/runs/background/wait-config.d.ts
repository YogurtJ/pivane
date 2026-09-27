import type { WaitToolConfig } from "../../shared/types.ts";
export declare const WAIT_TOOL_ENABLED_ENV = "PI_SUBAGENT_WAIT_TOOL_ENABLED";
export declare const WAIT_TOOL_DEFAULT_TIMEOUT_MS_ENV = "PI_SUBAGENT_WAIT_TOOL_DEFAULT_TIMEOUT_MS";
export interface ResolvedWaitToolConfig {
    enabled: boolean;
    defaultTimeoutMs?: number;
}
export declare function resolveWaitToolConfig(config?: WaitToolConfig, env?: Record<string, string | undefined>): ResolvedWaitToolConfig;
//# sourceMappingURL=wait-config.d.ts.map