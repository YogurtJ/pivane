import type { DefaultChildSessionFactoryOptions } from "../shared/child-session.ts";
import type { SubagentRunConfig } from "./subagent-runner.ts";
export type { SubagentRunConfig } from "./subagent-runner.ts";
type ExecutionModule = {
    runConfiguredSubagentExecution(config: SubagentRunConfig, options?: DefaultChildSessionFactoryOptions): Promise<void>;
};
export interface RunnerBootstrapOptions extends DefaultChildSessionFactoryOptions {
    /** Test-only seam for proving that execution loading stays behind startup commit. */
    loadExecutionModule?: () => Promise<ExecutionModule>;
}
export declare function validateSubagentRunConfig(value: unknown): asserts value is SubagentRunConfig;
/** Owns startup authorization and any revival lease across dynamically loaded execution. */
export declare function runConfiguredSubagent(rawConfig: unknown, options?: RunnerBootstrapOptions): Promise<void>;
//# sourceMappingURL=subagent-runner-bootstrap.d.ts.map