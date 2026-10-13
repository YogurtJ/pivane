import { SubagentWaitParams } from "../../extension/schemas.js";
import { resolveWaitToolConfig, waitForSubagents } from "./subagent-wait.js";
import { finalizeToolResult } from "../../extension/tool-result.js";
import { registerPinnedTool } from "../../extension/declaration-pinning.js";
export function registerWaitTool(pi, state, enabled = resolveWaitToolConfig().enabled, subscriptions, defaultTimeoutMs, child, hasPendingSupervisorRequest) {
    const description = `Wait for background work, then return. ${child ? "This child runtime has no native completion notifier: use blocking bg_wait to collect your owned descendants this turn and read their result references; agent_end draining does not synthesize results." : "Ordinary async subagent runs already wake this session natively; use bg_wait only for provider, detached, or other background work without native notification, when a same-turn result is needed."}
{} — first active run or provider item to finish or need attention.
{all:true} — all work active at call time.
{id} — one run; a finished async run returns its result references.
{id,nonBlocking:true} — subscribe to that run's wake and return now.
Timeout or a user message ends the wait without error; work keeps running.${enabled ? "" : "\nDisabled by config.waitTool or PI_SUBAGENT_WAIT_TOOL_ENABLED: returns immediately."}`;
    // Messages typed while the agent is busy (steer or follow-up) end open waits so they reach the model.
    const userInputWaits = new Set();
    pi.on("input", (event) => {
        if (event.source === "extension" || !event.streamingBehavior)
            return;
        for (const controller of userInputWaits)
            controller.abort();
    });
    const execute = async (_id, params, signal, onUpdate, ctx) => {
        const userInput = new AbortController();
        userInputWaits.add(userInput);
        try {
            return finalizeToolResult(await waitForSubagents(params, signal, {
                state,
                nestedRootRunId: child?.nestedRootRunId,
                events: pi.events,
                enabled,
                hasPendingSupervisorRequest,
                userInputSignal: userInput.signal,
                ...(defaultTimeoutMs !== undefined ? { defaultTimeoutMs } : {}),
                onUpdate,
                ...(subscriptions && ctx?.hasUI ? { subscribe: (input) => subscriptions.arm(input) } : {}),
            }));
        }
        finally {
            userInputWaits.delete(userInput);
        }
    };
    const primaryTool = {
        name: "bg_wait",
        label: "Background Wait",
        description,
        parameters: SubagentWaitParams,
        execute,
    };
    registerPinnedTool(pi, primaryTool);
}
//# sourceMappingURL=wait-tool.js.map