import { type GhosttyRunner } from "./actions.ts";
import type { InspectorPlugin } from "../types.ts";
export interface GhosttyPluginDeps {
    platform?: NodeJS.Platform;
    runner?: GhosttyRunner;
}
export declare function createGhosttyInspectorPlugin(deps?: GhosttyPluginDeps): InspectorPlugin;
//# sourceMappingURL=plugin.d.ts.map