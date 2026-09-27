import { type BuildInProcessChildLaunchInput, type InheritedChildRuntime } from "../shared/child-launch.ts";
import type { RunnerSubagentStep } from "../shared/parallel-utils.ts";
export interface RunnerChildLaunchContext {
    cwd: string;
    id: string;
    flatIndex: number;
    artifactsDir?: string;
    childIntercomTarget?: string;
    orchestratorIntercomTarget?: string;
    nestedRoute?: BuildInProcessChildLaunchInput["nestedRoute"];
    runFanoutBudget?: BuildInProcessChildLaunchInput["runFanoutBudget"];
    capabilityCeiling?: BuildInProcessChildLaunchInput["capabilityCeiling"];
    inheritedChildRuntime?: InheritedChildRuntime;
}
export declare function buildRunnerChildLaunch(step: RunnerSubagentStep, ctx: RunnerChildLaunchContext, attempt: {
    model?: string;
    sessionEnabled: boolean;
    sessionDir?: string;
    sessionName?: string;
    structuredOutput?: BuildInProcessChildLaunchInput["structuredOutput"];
    childWatchdog?: BuildInProcessChildLaunchInput["childWatchdog"];
    watchdogStatus: NonNullable<BuildInProcessChildLaunchInput["watchdogStatus"]>;
}): import("../shared/child-launch.ts").InProcessChildLaunch;
//# sourceMappingURL=runner-child-launch.d.ts.map