import { type HerdrClient } from "./client.ts";
import type { InspectorPlugin } from "../types.ts";
export interface HerdrPluginDeps {
    client?: HerdrClient;
}
export declare function createHerdrInspectorPlugin(deps?: HerdrPluginDeps): InspectorPlugin;
//# sourceMappingURL=plugin.d.ts.map