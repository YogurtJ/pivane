import { closeTmuxInspector, openTmuxInspector, readTmuxInspectorBindingForTarget, statusTmuxInspector } from "./actions.js";
import { createTmuxClient } from "./client.js";
export function createTmuxInspectorPlugin(deps = {}) {
    const platform = deps.platform ?? process.platform;
    const client = deps.client ?? createTmuxClient();
    return {
        name: "tmux",
        available: (context) => platform !== "win32" && Boolean(context.env.TMUX),
        owns: (context) => readTmuxInspectorBindingForTarget(context.target) !== undefined,
        open: (context, launch, params) => openTmuxInspector(context, launch, params.focus === true, client),
        status: (context) => statusTmuxInspector(context, client),
        close: (context) => closeTmuxInspector(context, client),
    };
}
//# sourceMappingURL=plugin.js.map