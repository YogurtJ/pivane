import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { MissionStoreConfig } from "../missions/types.ts";
import { type AuthorityPolicyConfig } from "../policy/authority.ts";
import { type Details, type SubagentState } from "../shared/types.ts";
import type { InspectorAction, InspectorParams, InspectorPlugin } from "./types.ts";
export { INSPECTOR_ACTIONS } from "./types.ts";
export type { InspectorAction, InspectorParams, InspectorPlugin } from "./types.ts";
export interface InspectorDispatcherDeps {
    state?: SubagentState;
    asyncDirRoot?: string;
    resultsDir?: string;
    missions?: MissionStoreConfig;
    authorityPolicy?: AuthorityPolicyConfig;
    sessionRoots?: string[];
    cwd: string;
    signal?: AbortSignal;
    now?: () => Date;
    runnerPath?: string;
    env?: NodeJS.ProcessEnv;
    plugins?: readonly InspectorPlugin[];
}
export declare function handleInspectorAction(action: InspectorAction, params: InspectorParams, deps: InspectorDispatcherDeps): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=actions.d.ts.map