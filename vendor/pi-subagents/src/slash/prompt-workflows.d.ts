import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
interface PromptWorkflow {
    name: string;
    description: string;
    body: string;
    filePath: string;
    agent: string;
    context?: "fresh" | "fork";
    model?: string;
    skill?: string | string[] | false;
    cwd?: string;
    chain?: string;
}
type PromptWorkflowRunner = (params: SubagentParamsLike, ctx: ExtensionContext) => Promise<void>;
export declare function discoverPromptWorkflows(cwd: string): PromptWorkflow[];
export declare function registerPromptWorkflowCommands(input: {
    pi: ExtensionAPI;
    run: PromptWorkflowRunner;
}): void;
export {};
//# sourceMappingURL=prompt-workflows.d.ts.map