import { SubagentWaitParams } from "../../extension/schemas.js";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.js";
import { finalizeToolResult } from "../../extension/tool-result.js";
export function registerWaitTool(pi, state, enabled = resolveWaitToolConfig().enabled, subscriptions, defaultTimeoutMs, child, hasPendingSupervisorRequest) {
    const description = `Wait for background, provider, or detached work that has no native completion notification, then return.

${child ? "This child runtime does not install the root session's native completion notifier. Use blocking bg_wait to collect your owned descendants during this turn, then read the returned result references before synthesizing findings. Automatic draining at agent_end keeps owned work alive but does not synthesize its results." : "Ordinary async subagent runs already notify this session natively when they complete or need attention. In an interactive chat, return control instead of calling this merely to wait. Use this tool for provider jobs, remembered detached foreground runs, or other background work without a native notification path. Headless runs auto-drain current-session subagent work at agent_end; use this tool only when the current turn must receive non-notifying background work results."}

• { } — return when the first initially active async run or registered provider item finishes, or when a subagent needs attention.
• { all: true } — wait for every async run, provider item, and remembered detached foreground descendant that was active when the call began.
• { id: "..." } — wait for one async or remembered detached foreground subagent run (id or prefix). Named async runs that already finished return their terminal result references.
• { id: "...", nonBlocking: true } — resolve the prefix once, persist an exact-run wake subscription, and return immediately. Use this for detached work without native completion delivery; the originating interactive session wakes on completion, failure, attention, reconciliation failure, or timeout.
• { stopOnAttention: false } — for blocking waits only, keep waiting through idle or long-thinking attention; supervisor/contact requests still stop the wait.
• { timeoutMs: 600000 } — stop waiting after N ms; active work keeps running. Omitted values use waitTool.defaultTimeoutMs, then 30 minutes. Window expiry returns a non-error window_elapsed result with active work identities.

Non-blocking subscriptions are visible in subagent status and differ from disabling waitTool: waitTool.enabled=false returns immediately without registering any future wake. Provider jobs are session-scoped and identified exactly, so replacing one job with another cannot hide a completion. Provider extensions must be explicitly loaded in this process. In a child agent, keep \`bg_wait\` in the child tool allowlist and load each provider through the agent's extensions or subagentOnlyExtensions; this tool never loads providers or grants tools itself.${enabled ? "" : "\n\nConfigured behavior: bg_wait is disabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED and returns immediately without blocking."}`;
    const execute = async (_id, params, signal, onUpdate, ctx) => finalizeToolResult(await waitForSubagents(params, signal, {
        state,
        nestedRootRunId: child?.nestedRootRunId,
        events: pi.events,
        enabled,
        hasPendingSupervisorRequest,
        ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
        onUpdate,
        ...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
    }));
    const primaryTool = {
        name: "bg_wait",
        label: "Background Wait",
        description,
        parameters: SubagentWaitParams,
        execute,
    };
    pi.registerTool(primaryTool);
}
//# sourceMappingURL=wait-tool.js.map