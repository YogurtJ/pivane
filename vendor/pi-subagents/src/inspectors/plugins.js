import { createHerdrInspectorPlugin } from "./herdr/plugin.js";
import { createGhosttyInspectorPlugin } from "./ghostty/plugin.js";
/** Built-in inspector plugins, ordered by host preference. */
export function createBuiltinInspectorPlugins() {
    return [createHerdrInspectorPlugin(), createGhosttyInspectorPlugin()];
}
//# sourceMappingURL=plugins.js.map