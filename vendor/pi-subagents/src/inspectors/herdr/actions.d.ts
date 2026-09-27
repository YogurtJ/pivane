import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details } from "../../shared/types.ts";
import type { InspectorContext, InspectorLaunch, InspectorParams, InspectorTarget } from "../types.ts";
import { type HerdrClient } from "./client.ts";
export interface HerdrInspectorBinding {
    schemaVersion: 1;
    kind: "herdr-inspector";
    runId: string;
    asyncDir: string;
    childIndex?: number;
    missionId?: string;
    missionPath?: string;
    paneId: string;
    openedAt: string;
    lastFocusedAt?: string;
    herdrVersion?: string;
    command: string;
}
export declare function bindingPath(asyncDir: string, index?: number): string;
export declare function readHerdrInspectorBinding(asyncDir: string, index?: number): HerdrInspectorBinding | undefined;
/** Read a binding only when it belongs to the requested inspector target. */
export declare function readHerdrInspectorBindingForTarget(target: InspectorTarget): HerdrInspectorBinding | undefined;
export declare function openHerdrInspector(context: InspectorContext, launch: InspectorLaunch, params: InspectorParams, client: HerdrClient): Promise<AgentToolResult<Details>>;
export declare function statusHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>>;
export declare function closeHerdrInspector(context: InspectorContext, client: HerdrClient): Promise<AgentToolResult<Details>>;
//# sourceMappingURL=actions.d.ts.map