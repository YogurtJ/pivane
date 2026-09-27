import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgentSnapshot, findBlockingAgentDiagnostic, formatUnknownAgentError, resolveAgentName, unknownAgentDiagnosticContext } from "../agents/agents.js";
import { resolveExecutionAgentScope } from "../agents/agent-scope.js";
import { normalizeSkillInput, resolveSkillsWithFallback } from "../agents/skills.js";
import { inheritsParentModel, resolveEffectiveSubagentModel, resolveModelOrigin, resolveModelSelection } from "../runs/shared/model-resolution.js";
import { resolveModelScopesForAgent } from "../runs/shared/model-scope.js";
import { applyThinkingSuffix, resolvePiLaunchToolPlan } from "../runs/shared/child-tool-plan.js";
import { buildEffectiveSystemPrompt } from "../runs/shared/effective-system-prompt.js";
import { normalizeSingleOutputOverride, resolveSingleOutputPath } from "../runs/shared/single-output.js";
import { getArtifactPaths, getArtifactsDir } from "../shared/artifacts.js";
import { resolveEffectiveThinking } from "../shared/model-info.js";
import { assertThinkingWithinCeiling, intersectThinkingCeilings } from "../shared/thinking-ceiling.js";
import { SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../shared/types.js";
import { capabilityCeilingAgentRestrictionMessage, intersectSubagentCapabilityCeilings } from "../runs/shared/capability-ceiling.js";
import { resolvePermissionRules } from "../runs/shared/permissions.js";
import { resolveStepBehavior } from "../shared/settings.js";
import { canPreferForkFromSnapshot, resolveSubagentLaunchContext } from "../shared/fork-context.js";
import { loadConfig } from "../extension/config.js";
import { applyIntercomBridgeToAgent, resolveIntercomBridge, validateIntercomBridgeConfig } from "../intercom/intercom-bridge.js";
import { AGENT_DEFINITION_PROJECTION_VERSION, resolveLaunchBinding, stableJsonDigest } from "../shared/launch-contract.js";
import { DIRS, TEMP_ROOT_DIR } from "../shared/types.js";
import { processTerminalCandidatePath, processTerminalPath } from "../runs/background/process-terminal.js";
import { resultFilePath } from "../runs/background/result-files.js";
import { nestedResultsPath } from "../runs/shared/nested-events.js";
import { normalizeExtensionBindings } from "../runs/shared/extension-bindings.js";
import { resolveRequiredChildExtensions } from "../shared/required-child-extensions.js";
// v3: the contract reports the resolved Intercom bridge state and binds its
// prompt and tools into launchContractDigest, matching execution (#2127).
export const SUBAGENT_LAUNCH_CONTRACT_VERSION = 3;
/** Stands in for the parent session target when the host does not supply one; only custom templates that name the session read it. */
const PREFLIGHT_ORCHESTRATOR_TARGET = "preflight";
function packageVersion() {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf-8"));
    if (typeof parsed.version !== "string" || !parsed.version.trim()) {
        throw new Error(`Invalid package version in '${packagePath}'.`);
    }
    return parsed.version;
}
function digestContract(contract) {
    return stableJsonDigest(contract);
}
function normalizeAvailableModels(models) {
    return (models ?? []).map((model) => ({ ...model, fullId: model.fullId ?? `${model.provider}/${model.id}` }));
}
function resolveLaunchContractContext(input, agent) {
    return resolveSubagentLaunchContext({
        explicitContext: input.context,
        agentDefaultContext: agent.defaultContext,
        defaultSubagentContext: loadConfig().defaultSubagentContext,
        canUseImplicitFork: canPreferForkFromSnapshot({
            parentSessionFile: input.parentSessionFile,
            leafId: input.parentLeafId,
        }),
    });
}
function taskWorkspaceScopeAuthorityDiagnostic(task) {
    if (!task)
        return undefined;
    const text = task.replace(/\s+/g, " ").trim();
    if (!text)
        return undefined;
    const createsWorkspacePackage = /\b(?:add|create|introduce|make|set up)\b.{0,80}\b(?:new\s+)?(?:workspace\s+)?package\b/i.test(text)
        || /\b(?:new\s+)?package\b.{0,80}\b(?:workspace|monorepo)\b/i.test(text);
    if (!createsWorkspacePackage)
        return undefined;
    const packageOnlyAuthority = /\b(?:only|solely)\b.{0,40}\b(?:edit|change|modify|touch|write(?:\s+to)?)\b.{0,80}\b(?:package(?:\s+directory)?|packages\/[\w.-]+)\b/i.test(text)
        || /\b(?:do not|don't|must not)\b.{0,40}\b(?:edit|change|modify|touch|write(?:\s+to)?)\b.{0,80}\b(?:root|workspace|lockfile|metadata)\b/i.test(text)
        || /\bwithout\b.{0,40}\b(?:root|workspace|lockfile|metadata)\b.{0,40}\b(?:edit|change|modification|write)s?\b/i.test(text);
    if (!packageOnlyAuthority)
        return undefined;
    return {
        code: "workspace_scope_authority",
        severity: "warning",
        message: "Task asks for a workspace package change while limiting authority to package-scope edits. New workspace packages often need root workspace metadata or lockfile changes, so confirm that authority before launch.",
    };
}
function candidateList(inputAgent, selected, all) {
    return [...all.builtin, ...all.package, ...all.user, ...all.project]
        .filter((agent) => Boolean(resolveAgentName(inputAgent, [agent]).agent))
        .map((agent) => ({
        name: agent.name,
        ...(agent.localName ? { localName: agent.localName } : {}),
        ...(agent.packageName ? { packageName: agent.packageName } : {}),
        source: agent.source,
        filePath: agent.filePath,
        ...(agent.disabled === true ? { disabled: true } : {}),
        selected: Boolean(selected && agent.filePath === selected.filePath && agent.name === selected.name),
    }));
}
export async function resolveSubagentLaunchContract(input) {
    const diagnostics = [];
    const authorityDiagnostic = taskWorkspaceScopeAuthorityDiagnostic(input.task);
    if (authorityDiagnostic)
        diagnostics.push(authorityDiagnostic);
    const effectiveCwd = path.resolve(input.cwd);
    try {
        if (!fs.statSync(effectiveCwd).isDirectory()) {
            return { ok: false, code: "invalid_cwd", message: `cwd '${effectiveCwd}' is not a directory.`, diagnostics };
        }
    }
    catch (error) {
        const detail = error instanceof Error ? ` ${error.message}` : "";
        return { ok: false, code: "invalid_cwd", message: `cwd '${effectiveCwd}' is not a directory.${detail}`, diagnostics };
    }
    if (input.context !== undefined && input.context !== "fresh" && input.context !== "fork") {
        return { ok: false, code: "unsupported_mode", message: `Unsupported context '${String(input.context)}'; expected 'fresh' or 'fork'.`, diagnostics };
    }
    if (input.artifactDir !== undefined && input.artifactDir !== "project" && input.artifactDir !== "session" && input.artifactDir !== "temp") {
        return { ok: false, code: "invalid_artifact_dir", message: `Unsupported artifactDir '${String(input.artifactDir)}'; expected 'project', 'session', or 'temp'.`, diagnostics };
    }
    const bridgeOverride = input.intercomBridge === undefined ? undefined : validateIntercomBridgeConfig({ value: input.intercomBridge, label: "intercomBridge" });
    if (bridgeOverride && !bridgeOverride.ok) {
        return { ok: false, code: "invalid_intercom_bridge", message: bridgeOverride.error, diagnostics };
    }
    // Execution always derives a non-empty target, so an empty one here would
    // silently deactivate the bridge and break parity instead of proving it.
    if (input.orchestratorTarget !== undefined && (typeof input.orchestratorTarget !== "string" || !input.orchestratorTarget.trim())) {
        return { ok: false, code: "invalid_intercom_bridge", message: "orchestratorTarget must be a non-empty string when provided.", diagnostics };
    }
    const scope = resolveExecutionAgentScope(input.agentScope);
    const parentProvider = input.preferredProvider ?? input.parentModel?.provider;
    const discovery = discoverAgentSnapshot(effectiveCwd, scope, parentProvider, { includeChains: false });
    const discovered = discovery.effective;
    const resolvedAgent = resolveAgentName(input.agent, discovered.agents);
    const ambiguousCandidates = resolvedAgent.error
        ? discovered.agents.filter((agent) => resolveAgentName(input.agent, [agent]).agent)
        : resolvedAgent.agent;
    const invalidAgent = findBlockingAgentDiagnostic(input.agent, ambiguousCandidates, discovered.agentDiagnostics);
    if (invalidAgent) {
        const message = `Agent '${input.agent}' has invalid configuration: ${invalidAgent.error}`;
        return { ok: false, code: "missing_agent", message, diagnostics: [{ code: "missing_agent", severity: "error", message }] };
    }
    if (resolvedAgent.error) {
        return { ok: false, code: "ambiguous_agent", message: resolvedAgent.error, diagnostics };
    }
    if (!resolvedAgent.agent) {
        return { ok: false, code: "missing_agent", message: formatUnknownAgentError(input.agent, unknownAgentDiagnosticContext(discovered)), diagnostics };
    }
    const definitionAgent = resolvedAgent.agent;
    let extensionBindings;
    try {
        extensionBindings = normalizeExtensionBindings(input.extensionBindings)?.value;
    }
    catch (error) {
        return { ok: false, code: "invalid_extension_bindings", message: error instanceof Error ? error.message : String(error), diagnostics };
    }
    if (extensionBindings !== undefined && (definitionAgent.runner?.type === "external-cli" || definitionAgent.runner?.type === "external-job")) {
        return { ok: false, code: "unsupported_mode", message: `extensionBindings is not supported for runner.type='${definitionAgent.runner.type}'.`, diagnostics };
    }
    const context = resolveLaunchContractContext(input, definitionAgent);
    if (context === "fork") {
        diagnostics.push({ code: "host_required", severity: "host-required", message: "Exact fork session branching requires Pi host session snapshots." });
    }
    // Execution rewrites the discovered agent through the bridge before any
    // other launch resolution, so preflight must hash the same rewritten agent.
    const bridge = resolveIntercomBridge({
        config: loadConfig().intercomBridge,
        ...(bridgeOverride ? { override: bridgeOverride.value } : {}),
        context,
        orchestratorTarget: input.orchestratorTarget ?? PREFLIGHT_ORCHESTRATOR_TARGET,
    });
    if (bridge.active && bridge.interpolatesOrchestratorTarget && input.orchestratorTarget === undefined) {
        diagnostics.push({ code: "host_required", severity: "host-required", message: "The intercomBridge instruction file names the supervisor session; supply orchestratorTarget to bind the exact child prompt." });
    }
    const agent = applyIntercomBridgeToAgent(definitionAgent, bridge);
    const effectiveCapabilityCeiling = intersectSubagentCapabilityCeilings(input.capabilityCeiling, input.inheritedCapabilityCeiling);
    const restrictionMessage = capabilityCeilingAgentRestrictionMessage(agent.name, effectiveCapabilityCeiling);
    if (restrictionMessage)
        return { ok: false, code: "restricted_agent", message: restrictionMessage, diagnostics };
    const runId = input.runId ?? "preflight";
    const skillInput = normalizeSkillInput(input.skill);
    const outputOverride = normalizeSingleOutputOverride(input.output, agent.output);
    const behavior = resolveStepBehavior(agent, {
        ...(outputOverride !== undefined ? { output: outputOverride } : {}),
        ...(input.outputMode !== undefined ? { outputMode: input.outputMode } : {}),
        ...(skillInput !== undefined ? { skills: skillInput } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}),
    });
    const requestedSkills = behavior.skills === false ? [] : behavior.skills;
    const resolvedSkills = resolveSkillsWithFallback(requestedSkills, effectiveCwd, effectiveCwd, agent.skillPath, agent.filePath ? path.dirname(agent.filePath) : effectiveCwd);
    if (resolvedSkills.missing.includes("pi-subagents")) {
        return { ok: false, code: "missing_skill", message: "The pi-subagents orchestration skill is not child-injectable.", diagnostics };
    }
    if (resolvedSkills.missing.length > 0)
        diagnostics.push({ code: "missing_skill", severity: "error", message: `Missing skills: ${resolvedSkills.missing.join(", ")}` });
    const externalRunner = agent.runner?.type === "external-cli" || agent.runner?.type === "external-job";
    if (externalRunner && behavior.outputSchema) {
        return { ok: false, code: "unsupported_mode", message: `Agent '${agent.name}' uses runner.type='${agent.runner?.type}' and does not support: structured output.`, diagnostics };
    }
    const availableModels = normalizeAvailableModels(input.availableModels);
    const preferredProvider = agent.modelProvider ?? input.preferredProvider ?? input.parentModel?.provider;
    const modelScopes = resolveModelScopesForAgent(discovered.modelScope, agent.name, input.parentModel);
    const modelOrigin = resolveModelOrigin({ explicitModel: input.model, agentModel: agent.model, parentModel: input.parentModel });
    const primaryModel = externalRunner
        ? undefined
        : resolveEffectiveSubagentModel(input.model, agent.model, input.parentModel, availableModels, preferredProvider, {
            scope: modelScopes,
            source: modelOrigin === "explicit" ? "explicit" : "inherited",
        });
    const effectiveThinkingConfig = input.thinking !== undefined ? input.thinking : agent.thinking;
    const thinkingCeiling = externalRunner ? undefined : intersectThinkingCeilings(discovered.maxThinking, input.thinkingCeiling, input.inheritedThinkingCeiling);
    const model = externalRunner ? undefined : applyThinkingSuffix(resolveModelSelection(primaryModel, availableModels, preferredProvider, {
        scope: modelScopes,
        primaryModelFromParent: modelOrigin === "inherited" || inheritsParentModel(input.model, agent.model, input.parentModel),
        origin: modelOrigin,
    }).model, effectiveThinkingConfig, input.thinking !== undefined);
    if (!externalRunner) {
        try {
            assertThinkingWithinCeiling({ model, configThinking: effectiveThinkingConfig, ceiling: thinkingCeiling, agent: agent.name, runId });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            diagnostics.push({ code: "thinking_ceiling", severity: "error", message });
            return { ok: false, code: "thinking_ceiling", message, diagnostics };
        }
    }
    let toolPlan;
    const permissionRules = resolvePermissionRules(loadConfig().permissions, agent.permissions);
    const fast = input.fast ?? agent.fast;
    const requiredExtensions = externalRunner ? [] : resolveRequiredChildExtensions(input.parentSessionId);
    try {
        toolPlan = resolvePiLaunchToolPlan({
            tools: agent.tools,
            excludeTools: agent.excludeTools,
            allowNestedSubagents: agent.allowNestedSubagents,
            extensions: agent.extensions,
            subagentOnlyExtensions: agent.subagentOnlyExtensions,
            requiredExtensions,
            mcpDirectTools: agent.mcpDirectTools,
            cwd: effectiveCwd,
            requireReadTool: resolvedSkills.resolved.length > 0,
            structuredOutput: Boolean(behavior.outputSchema),
            fast,
            model,
            capabilityCeiling: effectiveCapabilityCeiling,
            agentName: agent.name,
            permissionRules,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({ code: "denied_required_tool", severity: "error", message });
        return { ok: false, code: "denied_required_tool", message, diagnostics };
    }
    const artifactsEnabled = input.artifacts !== false;
    const artifactsDir = artifactsEnabled ? getArtifactsDir(input.parentSessionFile ?? null, effectiveCwd, input.artifactDir) : undefined;
    const artifactPaths = artifactsDir ? getArtifactPaths(artifactsDir, runId, agent.name, 0) : undefined;
    const outputPath = resolveSingleOutputPath(behavior.output, effectiveCwd, effectiveCwd, artifactsDir ? path.join(artifactsDir, "outputs", runId) : undefined);
    // An explicit sessionDir is a root keyed by the child run id, matching the
    // sibling sessionRoot derivation; hosts omitting runId get the documented
    // deterministic "preflight" placeholder.
    const sessionRoot = input.sessionDir ? path.join(path.resolve(input.sessionDir), runId) : input.sessionRoot ? path.join(path.resolve(input.sessionRoot), runId) : undefined;
    const sessionDir = sessionRoot ? path.join(sessionRoot, "run-0") : undefined;
    const lifecycleAsyncDir = input.nestedRootRunId
        ? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", input.nestedRootRunId, runId)
        : path.join(DIRS.async, runId);
    const lifecycleResultPath = input.nestedRootRunId
        ? nestedResultsPath(input.nestedRootRunId, runId)
        : resultFilePath(DIRS.results, runId);
    if (!sessionDir)
        diagnostics.push({ code: "host_required", severity: "host-required", message: "No sessionRoot/sessionDir was supplied; exact child session paths require the Pi host session-root policy." });
    if (!externalRunner && input.availableModels === undefined && (input.model || agent.model || input.parentModel)) {
        diagnostics.push({ code: "host_required", severity: "host-required", message: "No availableModels snapshot was supplied; model resolution may differ from the active Pi host registry." });
    }
    if (resolvedSkills.missing.length > 0) {
        return { ok: false, code: "missing_skill", message: `Missing skills: ${resolvedSkills.missing.join(", ")}`, diagnostics };
    }
    const effectiveThinking = resolveEffectiveThinking(model, effectiveThinkingConfig);
    const binding = resolveLaunchBinding({
        agent,
        task: input.task ?? "",
        model,
        ...(fast !== undefined ? { fast } : {}),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        systemPrompt: buildEffectiveSystemPrompt({ agent, resolvedSkills: resolvedSkills.resolved, cwd: effectiveCwd, ...(outputPath ? { outputPath } : {}) }),
        skills: requestedSkills,
        toolPlan,
        ...(outputPath ? { outputPath } : {}),
        outputMode: behavior.outputMode,
        ...(behavior.outputSchema ? { structuredOutputSchema: behavior.outputSchema } : {}),
        ...(extensionBindings ? { extensionBindings } : {}),
    });
    const candidates = candidateList(input.agent, agent, discovery.all);
    const shadowedCandidates = candidates.filter((candidate) => !candidate.selected);
    const contractBase = {
        version: SUBAGENT_LAUNCH_CONTRACT_VERSION,
        runId,
        agent: {
            name: agent.name,
            ...(agent.localName ? { localName: agent.localName } : {}),
            ...(agent.packageName ? { packageName: agent.packageName } : {}),
            source: agent.source,
            filePath: agent.filePath,
            definitionProjectionVersion: AGENT_DEFINITION_PROJECTION_VERSION,
            definitionDigest: binding.definitionDigest,
            shadowedCandidates,
        },
        context,
        ...(model ? { model } : {}),
        ...(effectiveThinking ? { thinking: effectiveThinking } : {}),
        ...(thinkingCeiling ? { thinkingCeiling } : {}),
        systemPromptMode: agent.systemPromptMode,
        inheritProjectContext: agent.inheritProjectContext,
        inheritGlobalContext: agent.inheritGlobalContext,
        inheritSkills: agent.inheritSkills,
        skills: {
            requested: requestedSkills,
            resolved: resolvedSkills.resolved.map((skill) => ({ name: skill.name, path: skill.path, source: skill.source })),
            missing: resolvedSkills.missing,
        },
        tools: {
            requestedBuiltin: toolPlan.requestedBuiltinTools,
            declaredBuiltin: toolPlan.declaredBuiltinTools,
            ...(toolPlan.excludeTools.length > 0 ? { excludeTools: toolPlan.excludeTools } : {}),
            effectiveAllowlist: toolPlan.effectiveToolAllowlist,
            explicitAllowlist: toolPlan.explicitToolAllowlist,
            requiredChildTools: toolPlan.requiredChildTools,
            internalTools: toolPlan.internalTools,
            mcp: toolPlan.effectiveMcpSelections,
            effectiveMcpTools: toolPlan.effectiveMcpTools,
            toolExtensionPaths: toolPlan.toolExtensionPaths,
            runtimeExtensions: toolPlan.runtimeExtensions,
            configuredExtensions: toolPlan.configuredExtensions,
            requiredExtensionIds: toolPlan.requiredExtensions.map(({ id }) => id),
            // Required paths are private launch authority; preflight exposes their safe IDs above.
            extensionArgs: toolPlan.extensionArgs.filter((extensionPath) => !requiredExtensions.some(({ path }) => path === extensionPath)),
            disableAmbientExtensions: toolPlan.disableAmbientExtensions,
            fanoutAuthorized: toolPlan.fanoutAuthorized,
            ...(toolPlan.capabilityCeiling ? { capabilityCeiling: toolPlan.capabilityCeiling } : {}),
            ...(toolPlan.capabilityAudit ? { capabilityAudit: toolPlan.capabilityAudit } : {}),
        },
        intercomBridge: bridge.active && bridge.mode !== "off" ? { active: true, mode: bridge.mode } : { active: false, mode: bridge.mode },
        roots: {
            cwd: effectiveCwd,
            ...(sessionRoot ? { sessionRoot } : {}),
            ...(sessionDir ? { sessionDir, sessionFile: path.join(sessionDir, "session.jsonl") } : {}),
            ...(artifactsDir ? { artifactsDir } : {}),
            ...(artifactPaths ? { artifactPaths } : {}),
            ...(outputPath ? { outputPath } : {}),
            lifecycle: {
                asyncDir: lifecycleAsyncDir,
                resultPath: lifecycleResultPath,
                statusPath: path.join(lifecycleAsyncDir, "status.json"),
                eventsPath: path.join(lifecycleAsyncDir, "events.jsonl"),
                processTerminalPath: processTerminalPath(lifecycleAsyncDir),
                processTerminalCandidatePath: processTerminalCandidatePath(lifecycleAsyncDir),
            },
        },
        protocol: {
            lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
            packageVersion: packageVersion(),
        },
        diagnostics,
        launchContractDigest: binding.launchContractDigest,
    };
    return { ok: true, contract: { ...contractBase, digest: digestContract(contractBase) } };
}
//# sourceMappingURL=preflight.js.map