/** Native runner construction, separate from its executable entrypoint and attempt loop. */
import * as path from "node:path";
import { buildInProcessChildLaunch } from "../shared/child-launch.js";
import { deriveForkPromptCacheKey } from "../shared/child-tool-plan.js";
import { normalizeExtensionBindings } from "../shared/extension-bindings.js";
import { formatAcceptancePrompt } from "../shared/acceptance.js";
import { isAgentContract } from "../shared/agent-contract.js";
export function buildRunnerChildLaunch(step, ctx, attempt) {
    // Resource-backed system instructions survive SDK split-turn compaction verbatim.
    const acceptancePrompt = step.effectiveAcceptance
        ? formatAcceptancePrompt(step.effectiveAcceptance, { reportOptional: isAgentContract(step.agentContract), structuredOutput: Boolean(step.structuredOutput?.acceptanceReportPath) })
        : "";
    return buildInProcessChildLaunch({
        machine: step.machine,
        remoteSkillNames: step.skills,
        remoteReads: step.remoteReads,
        parentSessionId: step.parentSessionId,
        forkCacheKey: step.context === "fork" ? deriveForkPromptCacheKey(step.parentSessionId) : undefined,
        sessionEnabled: attempt.sessionEnabled,
        sessionDir: attempt.sessionDir,
        sessionFile: step.sessionFile,
        model: attempt.model,
        inheritProjectContext: step.inheritProjectContext,
        inheritGlobalContext: step.inheritGlobalContext,
        inheritSkills: step.inheritSkills,
        requireReadTool: Boolean(step.skills?.length),
        tools: step.tools,
        excludeTools: step.excludeTools,
        allowNestedSubagents: step.allowNestedSubagents,
        descendantAllowedAgents: step.allowedAgents,
        extensions: step.extensions,
        subagentOnlyExtensions: step.subagentOnlyExtensions,
        requiredExtensions: step.requiredExtensions,
        fast: step.fast,
        systemPrompt: acceptancePrompt ? `${step.systemPrompt ?? ""}\n${acceptancePrompt}` : step.systemPrompt ?? "",
        systemPromptMode: step.systemPromptMode,
        mcpDirectTools: step.mcpDirectTools,
        extensionBindings: normalizeExtensionBindings(step.extensionBindings)?.value,
        capabilityCeiling: step.capabilityCeiling ?? ctx.capabilityCeiling,
        cwd: step.cwd ?? ctx.cwd,
        intercomSessionName: ctx.childIntercomTarget,
        sessionName: attempt.sessionName,
        orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
        runId: ctx.id,
        childAgentName: step.agent,
        childIndex: ctx.flatIndex,
        nestedRoute: ctx.nestedRoute,
        runFanoutBudget: ctx.runFanoutBudget ? {
            ...ctx.runFanoutBudget,
            ...(step.runFanoutPath ? { parentPath: `${ctx.runFanoutBudget.parentPath ? `${ctx.runFanoutBudget.parentPath}/` : ""}${step.runFanoutPath}` } : {}),
        } : undefined,
        structuredOutput: attempt.structuredOutput,
        toolBudget: step.toolBudget,
        permissionRules: step.permissionRules,
        permissionAuditPath: step.permissionRules && ctx.artifactsDir
            ? path.join(ctx.artifactsDir, "permission-audit", `${ctx.id}-${ctx.flatIndex}.jsonl`) : undefined,
        childWatchdog: attempt.childWatchdog,
        // registerChildWatchdog returns before reading the sink when unconfigured.
        ...(attempt.childWatchdog ? { watchdogStatus: attempt.watchdogStatus } : {}),
        waitToolEnabled: step.waitToolEnabled,
        waitToolDefaultTimeoutMs: step.waitToolDefaultTimeoutMs,
        thinkingCeiling: step.thinkingCeiling,
        maxSubagentDepth: step.maxSubagentDepth,
        inherited: ctx.inheritedChildRuntime,
        host: "runner",
    });
}
//# sourceMappingURL=runner-child-launch.js.map