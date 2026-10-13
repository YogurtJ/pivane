import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorTarget } from "../types.ts";
import type { TmuxClient } from "./client.ts";
export interface TmuxInspectorBinding {
    schemaVersion: 1;
    kind: "tmux-inspector";
    runId: string;
    asyncDir: string;
    childIndex?: number;
    paneId: string;
    serverPid?: string;
    openedAt: string;
    tmuxVersion?: string;
    missionId?: string;
    missionPath?: string;
    command: string;
}
export declare function bindingPath(asyncDir: string, index?: number): string;
export declare function readTmuxInspectorBinding(asyncDir: string, index?: number): TmuxInspectorBinding | undefined;
/** Read a binding only when it belongs to the requested inspector target. */
export declare function readTmuxInspectorBindingForTarget(target: InspectorTarget): TmuxInspectorBinding | undefined;
export declare function openTmuxInspector(context: InspectorContext, launch: InspectorLaunch, focus: boolean, client: TmuxClient): Promise<AgentToolResult<Details>>;
export declare function statusTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>>;
export declare function closeTmuxInspector(context: InspectorContext, client: TmuxClient): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=actions.d.ts.map