import { type TmuxClient } from "./client.ts";
import type { InspectorPlugin } from "../types.ts";
export interface TmuxPluginDeps {
    platform?: NodeJS.Platform;
    client?: TmuxClient;
}
export declare function createTmuxInspectorPlugin(deps?: TmuxPluginDeps): InspectorPlugin;
//# sourceMappingURL=plugin.d.ts.map