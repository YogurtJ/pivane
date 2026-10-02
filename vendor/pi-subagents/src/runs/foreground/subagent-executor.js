import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents, findBlockingAgentDiagnostic, formatUnknownAgentError, resolveAgentName, unknownAgentDiagnosticContext } from "../../agents/agents.js";
import { getArtifactsDir, getProjectArtifactPackagingWarning, getProjectSubagentsDir } from "../../shared/artifacts.js";
import { writeAtomicJson } from "../../shared/atomic-json.js";
import { createCapacityResilientJsonWriter } from "../../shared/capacity-resilient-json.js";
import { isStorageCapacityError } from "../../shared/file-system-retry.js";
import { resolveEffectiveThinking, toModelInfo } from "../../shared/model-info.js";
import { beginForegroundChild, finishForegroundChild, foregroundSchedulingSettled, settleForegroundSchedulingOwner, updateForegroundChild, } from "./foreground-control.js";
import { getLivePromptAudit, rewritePromptWithGuidance, updateLiveEffectivePrompt } from "./prompt-audit.js";
import { persistForegroundRunHistory, MAX_REMEMBERED_FOREGROUND_RUNS } from "./foreground-history.js";
import { resolveExecutionAgentScope } from "../../agents/agent-scope.js";
import { handleManagementAction } from "../../agents/agent-management.js";
import { handleRefinementAction } from "../../agents/agent-refinements.js";
import { buildDoctorReport } from "../../extension/doctor.js";
import { readSubagentGuide } from "../../extension/subagent-guide.js";
import { isWorkflowScriptPath, normalizePublicSubagentExecution, validateWorkflowCapacityOverrides } from "../../extension/public-execution.js";
import { readReplyWorkflowScript } from "../../extension/reply-workflow-script.js";
import { disabledFeatureNotice, disabledFeatureUseError, resolveDisabledFeatureSurface } from "../../shared/disabled-features.js";
import { runSync } from "./execution.js";
import { handleWatchdogToolAction, WATCHDOG_TOOL_ACTIONS } from "../../watchdog/tool-actions.js";
import { applyWatchdogLaunchRules } from "../../watchdog/rules.js";
import { childWatchdogProgressForModel } from "../../watchdog/child-status.js";
import { normalizeParentModel, resolveEffectiveSubagentModel, resolveModelOrigin, scopedModelIdsFromContext } from "../shared/model-resolution.js";
import { projectChainOutputSchemas, resolveEffectiveOutputSchema } from "../shared/child-launch-plan.js";
import { formatRetainedChildren, listRetainedChildren } from "../background/retained-children.js";
import { resolveModelScopesForAgent } from "../shared/model-scope.js";
import { recordRun } from "../shared/run-history.js";
import { getStepAgents, isParallelStep, isDynamicParallelStep, resolveExistingReadPaths, } from "../../shared/settings.js";
import { normalizeSkillInput } from "../../agents/skills.js";
import { buildAsyncRunnerSteps, DEFAULT_ASYNC_TIMEOUT_MS, executeAsyncChain, executeAsyncSingle, formatAsyncStartedMessage, isAsyncAvailable, workflowAwaitedAsyncResultPath } from "../background/async-execution.js";
import { updateActiveRunIndex } from "../background/active-run-index.js";
import { steeringReceipt } from "../background/steering.js";
import { acquireActiveAsyncCapacity, ActiveAsyncCapacityError, getActiveAsyncCapacitySnapshot, resolveAbandonedSlotReleaseAfterMs, resolveMaxActiveAsyncRunsPerSession, transferActiveAsyncCapacity } from "../background/active-async-capacity.js";
import { isScheduledRunAction } from "../background/scheduled-runs.js";
import { encodeIndexSegment } from "../background/index-segment.js";
import { enqueueChainAppendRequest, readPendingChainAppendRequests, runnerStepOutputNames } from "../background/chain-append.js";
import { ChainOutputValidationError, validateChainOutputBindingsWithContext } from "../shared/chain-outputs.js";
import { acceptanceHasTypedVerify, normalizeGateAcceptance, resolveAcceptanceReportMode, TYPED_VERIFY_OUTPUT_SCHEMA_CONFLICT, validateAcceptanceInput, validateExecutionAcceptance, validateExecutionAcceptancePolicy } from "../shared/acceptance.js";
import { canPreferFork, createForkContextResolver, resolveSubagentLaunchContext } from "../../shared/fork-context.js";
import { createPrunedForkSessionWriter } from "../../shared/pruned-fork.js";
import { resolveCurrentSessionId } from "../../shared/session-identity.js";
import { currentCompletionOwnerId } from "../../shared/completion-owner.js";
import { SUBAGENT_ASYNC_COMPLETE_EVENT } from "../../shared/types.js";
import { applyIntercomBridgeToAgent, INTERCOM_BRIDGE_MARKER, resolveIntercomBridge, resolveIntercomSessionTarget, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import { formatControlIntercomMessage, formatControlNoticeMessage, resolveControlConfig, shouldNotifyControlEvent } from "../shared/subagent-control.js";
import { formatSpawnBudget, getSpawnBudgetSnapshot, grantSpawnBudget, preflightSpawnBudget, preflightSpawnBudgetGrant, reserveSpawnBudget } from "../shared/spawn-budget.js";
import { claimRunFanoutBatch, claimRunFanoutBatchWithCommit, createRunFanoutBudget, formatRunFanoutBudget, getRunFanoutBudgetSnapshot, readRunFanoutBudgetDescriptor, RunFanoutLimitError, writeRunFanoutBudgetDescriptor } from "../shared/run-fanout-budget.js";
import { retainLiveForegroundNestedRoute } from "../../integrations/pi-web-session-liveness.js";
import { HERDR_FOREGROUND_CONTROL_CHANGED_EVENT } from "../../integrations/herdr-status.js";
import { validateToolBudgetConfig } from "../shared/tool-budget.js";
import { usageBudgetExceededMessage, usageBudgetState, validateUsageBudgetConfig } from "../shared/usage-budget.js";
import { assertAgentAllowedByCapabilityCeiling, intersectSubagentCapabilityCeilings, resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.js";
import { isAgentContract } from "../shared/agent-contract.js";
import { normalizeExtensionBindings } from "../shared/extension-bindings.js";
import { resolveRequiredChildExtensions } from "../../shared/required-child-extensions.js";
import { finalizeSingleOutput, injectSingleOutputInstruction, normalizeSingleOutputOverride, outputPathMappingFromTask, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.js";
import { assertJsonSchemaObject, cleanupStructuredOutputRuntime, createStructuredOutputRuntime } from "../shared/structured-output.js";
import { compactForegroundDetails, getSingleResultOutput, PROMPT_REDACTED, readStatus, resolveChildCwd, sumResultsCost, sumResultsUsage, toAgentToolUsage } from "../../shared/utils.js";
import { discardPreservedWorktrees, formatParallelHandoffError, formatParallelHandoffReference, formatStoredParallelHandoffCleanup, parallelHandoffPath, readParallelHandoffManifest, recordParallelHandoffMerge, recordParallelHandoffSupersession, writeParallelHandoffGroup, writeWorktreeSetupHandoff } from "../shared/parallel-handoff.js";
import { summarizeContextModes } from "../shared/context-mode.js";
import { attachNestedChildrenToResultChildren, buildSubagentResultIntercomPayload, deliverSubagentResultIntercomEvent, formatSubagentResultReceipt, resolveSubagentResultStatus, stripDetailsOutputsForIntercomReceipt, } from "../../intercom/result-intercom.js";
import { applySteeringRecoveryAgentConfig, asyncReviveRequiresRecoveryDescriptor, buildRevivedAsyncTask, readAsyncRecoveryDescriptor, resolveAsyncResumeTarget, resolveAsyncRunLocation } from "../background/async-resume.js";
import { closeSteerInbox, consumeSteerRequests, deliverInterruptRequest, readRevivalBriefs, requestAsyncSteer, watchAsyncControlInbox } from "../background/control-channel.js";
import { createSteeringStatus, recordSteeringRequest, steeringStatus, updateSteeringTarget, waitForSteeringAction } from "../background/steering.js";
import { canQueueRetainedAsyncFollowUp, steerAsyncRun } from "./async-steering-action.js";
import { resolveWorkflowForegroundSteeringTarget, steerWorkflowForegroundTarget, steerWorkflowRun, } from "./workflow-foreground-steering.js";
import { stopAsyncRun } from "./async-stop-action.js";
import { dismissRecoveredWorkflow } from "./async-dismiss-action.js";
import { promotePausedWorkflowIfSettled, reconcileDetachedWorkflowChildCompletion } from "./workflow-detach-reconcile.js";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.js";
import { resolveAsyncRootResultPath, waitForImportedAsyncRoot } from "../background/chain-root-attachment.js";
import { awaitExistingAsyncRun, claimWorkflowAwaitedResult } from "../background/await-async-run.js";
import { fallbackResultPayloadPathForSessionRun, removeResultIndex, resultFilePath, writeAsyncResultFile } from "../background/result-files.js";
import { attachRootChildrenToSteps, createNestedRoute, findNestedControlResult, inheritedNestedParentAddressOf, inheritedNestedRouteOf, nestedRunScope, resolveNestedAsyncDir, retainNestedLookupRoute, snapshotNestedEventFiles, updateForegroundNestedProjection, writeNestedControlRequest, writeNestedEvent } from "../shared/nested-events.js";
import { resolveSubagentRunId } from "../background/run-id-resolver.js";
import { formatNestedRunStatusLines } from "../shared/nested-render.js";
import { isStoppableAsyncStatusStep, resolveAsyncStatusChild } from "../shared/child-identity.js";
import { inspectSubagentStatus } from "../background/run-status.js";
import { getExternalJobProvider } from "../../api/external-job-provider.js";
import { externalJobFollowUpRequestDigest, externalJobFollowUpRequestId, externalJobFollowUpRunId, externalJobPromptDigest, externalJobStableJson } from "../shared/external-job-runner.js";
import { externalCliReceiptMetadata, normalizeExternalCliRunnerStatus } from "../shared/external-cli-contract.js";
import { formatHerdrMachineRunnerUnsupported, resolveHerdrMachinePlacement } from "../shared/herdr-machine.js";
import { applyForceTopLevelAsyncOverride } from "../background/top-level-async.js";
import { handleMissionAction, MISSION_ACTIONS } from "../../missions/actions.js";
import { attachMissionToLaunchResult, prepareMissionLaunch, writeMissionAsyncBinding } from "../../missions/lifecycle.js";
import { MissionNotFoundError, updateMission } from "../../missions/store.js";
import { createMissionWorkflowState } from "../../missions/workflow-state.js";
import { resolveAuthorityDecision } from "../../policy/authority.js";
import { handleInspectorAction, INSPECTOR_ACTIONS } from "../../inspectors/actions.js";
import { getInspectorPlugins } from "../../inspectors/plugins.js";
import { handleHerdrProjectPaneAction, HERDR_PROJECT_PANE_ACTIONS } from "../../inspectors/herdr/project-panes.js";
import { previewSimpleWorkflowRun, runWorkflowScript, validateWorkflowScript, WorkflowScriptError } from "../../workflows/scripted-workflow.js";
import { formatIncrementalChildCompletion, incrementalChildCompletionTriggersTurn } from "../background/notify.js";
import { appendWorkflowChildJournal, findWorkflowReuseSource, matchWorkflowReuse, workflowChildFingerprint, workflowScriptDigest, workflowStopCause, WORKFLOW_RUNTIME_REPLACED_RELAUNCH_NOTICE } from "../../workflows/workflow-reuse.js";
import { executeWorkflowHostCommand, resolveWorkflowHostOutputClaimPath } from "../../workflows/host-command.js";
import { buildWorkflowReceipt, readWorkflowReceipt, workflowReceiptPath, resolveWorkflowReceiptResumeEntry, writeWorkflowReceipt } from "../../workflows/workflow-receipt.js";
import { formatWorkflowKeyRevival, recordWorkflowRevival, withWorkflowRevivals } from "../../workflows/workflow-revival.js";
import { upsertHostStep, validHostStepNodes } from "../shared/host-step-status.js";
import { assertWorkflowLaneKey, normalizeWorkflowLaneMetadata } from "../shared/lane-metadata.js";
import { parseWorkflowChildSummary, workflowChildProgress, workflowChildSummary } from "../../workflows/workflow-child-summary.js";
import { resolveWorkflowChatProgress } from "../../workflows/chat-progress.js";
import { annotateWorkflowPreflightTrace, formatWorkflowPreflight, formatWorkflowPreflightWarnings, normalizeWorkflowPreflight, workflowPreflightWarnings } from "../../workflows/workflow-preflight.js";
import { authorizeWorkflowResourceHost, claimWorkflowChildPermit, consumeWorkflowResourcePermit, validateWorkflowChildPermitRoot, } from "../../shared/workflow-child-permit.js";
import { deepFreezeWorkflowArgs, normalizeWorkflowArgs, resolveStructuredWorkflowResource, resolveWorkflowResource } from "../../workflows/workflow-resources.js";
import { stableJsonDigest } from "../../shared/launch-contract.js";
import { cleanupWorktrees, createWorktrees, preflightWorktreeSource, withWorktreeTransaction, diffWorktrees, formatWorktreeDiffSummary, } from "../shared/worktree.js";
import { createWorktreeCleanupPlan, formatWorktreeCleanupPlan } from "../shared/worktree-cleanup-plan.js";
import { DIRS, DEFAULT_ARTIFACT_CONFIG, DEFAULT_MAX_OUTPUT, DEFAULT_FORK_PREAMBLE, SUBAGENT_ACTIONS, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CHILD_STATUS_EVENT, SUBAGENT_CONTROL_EVENT, SUBAGENT_CONTROL_INTERCOM_EVENT, SUBAGENT_FOREGROUND_COMPLETE_EVENT, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION, checkSubagentDepth, resolveChildMaxSubagentDepth, resolveCurrentMaxSubagentDepth, resolveMaxSubagentSpawnsPerRun, truncateOutput, wrapForkTask, } from "../../shared/types.js";
import { deriveChildSessionName } from "../../shared/child-session-name.js";
const MUTATING_MANAGEMENT_ACTIONS = new Set(["create", "update", "delete", "eject", "disable", "enable", "reset", "grant-spawn-budget", "watchdog.configure", "mission.create", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close", "inspector.open", "inspector.close", "project.open", "project.close", "worktree.discard", "worktree.cleanup", "lane.recordMerge", "lane.recordSupersession", "refine", "refine.rollback", "dismiss", "schedule.create", "schedule.pause", "schedule.resume", "schedule.run", "schedule.run-due", "schedule.delete"]);
const DESTRUCTIVE_MANAGEMENT_ACTIONS = new Set(["delete", "eject", "disable", "reset", "mission.close", "worktree.discard", "refine.rollback", "inspector.close", "project.close", "stop", "interrupt", "schedule.delete"]);
function resolveSteerDeliveryMode(mode) {
    return mode === "steer" || mode === "follow_up" || mode === "auto" ? mode : undefined;
}
function editDistance(left, right) {
    const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
        let diagonal = previous[0];
        previous[0] = leftIndex;
        for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
            const above = previous[rightIndex];
            previous[rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
                ? diagonal
                : Math.min(diagonal, above, previous[rightIndex - 1]) + 1;
            diagonal = above;
        }
    }
    return previous[right.length];
}
function hasSingleAdjacentTransposition(left, right) {
    if (left.length !== right.length)
        return false;
    const mismatch = [...left].findIndex((character, index) => character !== right[index]);
    return mismatch >= 0
        && left[mismatch] === right[mismatch + 1]
        && left[mismatch + 1] === right[mismatch]
        && left.slice(mismatch + 2) === right.slice(mismatch + 2);
}
export function unknownSubagentActionMessage(action, disabled) {
    const requested = action.toLowerCase();
    const enabledActions = SUBAGENT_ACTIONS.filter((candidate) => !disabled?.actions.has(candidate));
    const suggestion = enabledActions.find((candidate) => {
        const distance = editDistance(requested, candidate);
        const closeMatch = distance <= Math.max(1, Math.floor(candidate.length / 4)) || hasSingleAdjacentTransposition(requested, candidate);
        if (DESTRUCTIVE_MANAGEMENT_ACTIONS.has(candidate))
            return distance === 1 && requested.length >= candidate.length - 1;
        return closeMatch;
    });
    const nextStep = 'Use subagent({ action: "status" }) to inspect runs or subagent({ action: "list" }) to inspect agents.';
    const validActions = `Valid: ${enabledActions.join(", ")}.`;
    return suggestion
        ? `Unknown action: ${action}. Did you mean ${suggestion}? ${nextStep} ${validActions}`
        : `Unknown action: ${action}. ${nextStep} ${validActions}`;
}
// These helpers mutate their argument, so keep calls scoped to fresh object literals or shallow copies.
function omitUndefinedProperties(value) {
    for (const key of Object.keys(value)) {
        if (value[key] === undefined)
            delete value[key];
    }
    return value;
}
function compactOptional(value) {
    for (const key of Object.keys(value)) {
        if (value[key] === undefined)
            delete value[key];
    }
    return value;
}
function rememberParentModel(state, sessionId, model) {
    if (state.currentSessionId !== sessionId)
        delete state.lastParentModel;
    state.currentSessionId = sessionId;
    const parentModel = normalizeParentModel(model);
    if (!sessionId)
        return parentModel;
    if (parentModel)
        state.lastParentModel = parentModel;
    return parentModel ?? state.lastParentModel;
}
function inheritedNestedRoute(deps) {
    return inheritedNestedRouteOf(deps.childRuntime);
}
function inheritedNestedParentAddress(deps) {
    return inheritedNestedParentAddressOf(deps.childRuntime);
}
function inheritedRunFanoutBudget(deps) {
    return deps.childRuntime?.runFanoutBudget;
}
function resolveRequestedCwd(runtimeCwd, requestedCwd) {
    return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}
function readWorkflowScriptFile(requestedPath, requestedCwd, runtimeCwd) {
    const scriptPath = path.resolve(resolveRequestedCwd(runtimeCwd, requestedCwd), requestedPath);
    let script;
    try {
        script = fs.readFileSync(scriptPath, "utf8");
    }
    catch (error) {
        return { error: `Failed to read workflow script '${scriptPath}': ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!script.trim())
        return { error: `Workflow script file '${scriptPath}' is empty.` };
    return { script };
}
export function removeForegroundControlIfIdle(state, runId, trackRetainedNestedRoute) {
    const control = state.foregroundControls.get(runId);
    if (control && (!foregroundSchedulingSettled(control) || (control.activeChildren?.size ?? 0) > 0))
        return false;
    if (control?.nestedRoute && trackRetainedNestedRoute) {
        try {
            if (retainLiveForegroundNestedRoute(state, control.nestedRoute))
                trackRetainedNestedRoute(runId);
        }
        catch (error) {
            console.error(`Failed to retain live nested descendants for foreground run '${runId}':`, error);
        }
    }
    retainNestedLookupRoute(state, control?.nestedRoute, control?.sessionId);
    state.foregroundControls.delete(runId);
    if (state.lastForegroundControlId === runId)
        state.lastForegroundControlId = null;
    return true;
}
function getForegroundControl(state, runId) {
    if (runId)
        return state.foregroundControls.get(runId);
    if (state.lastForegroundControlId) {
        const latest = state.foregroundControls.get(state.lastForegroundControlId);
        if (latest)
            return latest;
    }
    let newest;
    for (const control of state.foregroundControls.values()) {
        if (!newest || control.updatedAt > newest.updatedAt)
            newest = control;
    }
    return newest;
}
export function promptAuditRedoParams(value, rewrittenTask) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Prompt redo is missing a safe live launch contract.");
    const params = { ...value, task: rewrittenTask, async: false };
    delete params.workflowParentRunId;
    delete params.workflowKey;
    delete params.workflowChildAsyncId;
    delete params.workflowAwaitDetached;
    delete params.workflowParentDeadlineAt;
    delete params.suppressRoutineResultIntercom;
    if (params.worktree === true && Array.isArray(params.tasks))
        delete params.cwd;
    return params;
}
function formatForegroundActivity(control) {
    const facts = [];
    if (control.currentTool && control.currentToolStartedAt)
        facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
    else if (control.currentTool)
        facts.push(`tool ${control.currentTool}`);
    if (control.currentPath)
        facts.push(`path ${control.currentPath}`);
    if (control.turnCount !== undefined)
        facts.push(`${control.turnCount} turns`);
    if (control.tokens !== undefined)
        facts.push(`${control.tokens} tokens`);
    if (control.toolCount !== undefined)
        facts.push(`${control.toolCount} tools`);
    if (!control.lastActivityAt) {
        if (control.currentActivityState === "needs_attention")
            return ["needs attention", ...facts].join(" | ");
        if (control.currentActivityState === "active_long_running")
            return ["active but long-running", ...facts].join(" | ");
        return facts.length ? facts.join(" | ") : undefined;
    }
    const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
    if (control.currentActivityState === "needs_attention")
        return [`no activity for ${seconds}s`, ...facts].join(" | ");
    if (control.currentActivityState === "active_long_running")
        return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
    return [`active ${seconds}s ago`, ...facts].join(" | ");
}
function nestedResolutionScopeForExecutor(deps) {
    if (deps.allowMutatingManagementActions !== false)
        return undefined;
    const route = inheritedNestedRoute(deps);
    const address = route ? inheritedNestedParentAddress(deps) : undefined;
    return {
        routes: route ? [route] : [],
        ...(address ? { descendantOf: { parentRunId: address.parentRunId, ...(address.parentStepIndex !== undefined ? { parentStepIndex: address.parentStepIndex } : {}) } } : {}),
    };
}
function trustedSessionRootsForStatus(ctx, deps) {
    const roots = deps.config.defaultSessionDir ? [path.resolve(deps.expandTilde(deps.config.defaultSessionDir))] : [];
    const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
    if (parentSessionFile)
        roots.push(deps.getSubagentSessionRoot(parentSessionFile));
    return [...new Set(roots)];
}
/** Children follow the launching session's trust; hosts older than Pi's trust concept keep Pi's default. */
function sessionProjectTrust(ctx) {
    return typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : undefined;
}
function spawnBudgetErrorResult(message, mode) {
    return {
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode, results: [] },
    };
}
function withSpawnBudgetStatus(result, state, config, sessionId) {
    const spawnBudget = getSpawnBudgetSnapshot(state, config, sessionId);
    const activeAsyncCapacity = sessionId
        ? getActiveAsyncCapacitySnapshot(sessionId, resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession), {
            liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []),
            abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(config.capacity?.abandonedSlotReleaseAfterMs),
        })
        : { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 };
    state.activeAsyncCapacity = activeAsyncCapacity;
    return {
        ...result,
        content: result.content.map((item, index) => index === 0 && item.type === "text"
            ? { ...item, text: `${formatSpawnBudget(spawnBudget)}\nActive async capacity: ${activeAsyncCapacity.used}/${activeAsyncCapacity.limit || "unlimited"} used\n${item.text}` }
            : item),
        details: { ...result.details, spawnBudget, activeAsyncCapacity },
    };
}
function hasActiveSubagentChildren(state) {
    if (state.subagentInProgress || state.foregroundControls.size > 0)
        return true;
    const isActive = (status) => status === "queued" || status === "running";
    return [...state.asyncJobs.values(), ...(state.fleetJobs?.values() ?? [])].some((job) => isActive(job.status));
}
function countRequestedSubagentSpawns(params, config) {
    if (params.tasks)
        return params.tasks.length;
    if (params.chain) {
        return params.chain.reduce((total, step) => {
            if (isDynamicParallelStep(step))
                return total + (step.expand.maxItems ?? config.chain?.dynamicFanout?.maxItems ?? 0);
            return total + getStepAgents(step).length;
        }, 0);
    }
    return params.agent ? 1 : 0;
}
function staticRunFanoutPaths(params) {
    if (params.tasks)
        return params.tasks.map((_, index) => `tasks[${index}]`);
    if (params.chain)
        return params.chain.flatMap((step, stepIndex) => {
            if (isDynamicParallelStep(step))
                return [];
            if (isParallelStep(step))
                return step.parallel.map((_, itemIndex) => `chain[${stepIndex}].parallel[${itemIndex}]`);
            return [`chain[${stepIndex}]`];
        });
    return params.agent ? ["single"] : [];
}
function runFanoutErrorResult(error, mode) {
    return { content: [{ type: "text", text: error.message }], isError: true, details: { mode, results: [], runFanoutBudget: error.snapshot, runFanoutRejection: error.rejection } };
}
function withRunFanoutBudget(result, descriptor, options = {}) {
    const runFanoutBudget = getRunFanoutBudgetSnapshot(descriptor);
    return {
        ...result,
        content: options.annotateContent === false
            ? result.content
            : result.content.map((item, index) => index === 0 && item.type === "text" ? { ...item, text: `${formatRunFanoutBudget(runFanoutBudget)}\n${item.text}` } : item),
        details: { ...result.details, runFanoutBudget },
    };
}
function foregroundStatusResult(control) {
    let nestedWarning;
    try {
        updateForegroundNestedProjection(control);
    }
    catch (error) {
        nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const activity = formatForegroundActivity(control);
    const lines = [
        `Run: ${control.runId}`,
        "State: running",
        `Mode: ${control.mode}`,
        control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
        activity ? `Activity: ${activity}` : undefined,
    ].filter((line) => Boolean(line));
    lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
    if (nestedWarning)
        lines.push(`Warning: ${nestedWarning}`);
    return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}
function trimRememberedForegroundRuns(state) {
    if (!state.foregroundRuns)
        return;
    while (state.foregroundRuns.size > MAX_REMEMBERED_FOREGROUND_RUNS) {
        const oldestTerminal = [...state.foregroundRuns.values()]
            .filter((run) => !run.children.some((child) => child.status === "detached"))
            .sort((left, right) => left.updatedAt - right.updatedAt)[0];
        if (!oldestTerminal)
            break;
        state.foregroundRuns.delete(oldestTerminal.runId);
    }
}
function persistRememberedForegroundRuns(state) {
    try {
        persistForegroundRunHistory(state);
    }
    catch (error) {
        console.error("Failed to persist foreground run history:", error);
    }
}
function foregroundChildActivityFromProgress(progress) {
    return {
        ...(progress?.activityState ? { activityState: progress.activityState } : {}),
        ...(progress?.lastActivityAt !== undefined ? { lastActivityAt: progress.lastActivityAt } : {}),
        ...(progress?.currentTool ? { currentTool: progress.currentTool } : {}),
        ...(progress?.currentToolStartedAt !== undefined ? { currentToolStartedAt: progress.currentToolStartedAt } : {}),
        ...(progress?.currentPath ? { currentPath: progress.currentPath } : {}),
        ...(progress?.turnCount !== undefined ? { turnCount: progress.turnCount } : {}),
        ...(progress?.tokens !== undefined ? { tokens: progress.tokens } : {}),
        ...(progress?.window !== undefined ? { window: progress.window } : {}),
        ...(progress?.windowPeak !== undefined ? { windowPeak: progress.windowPeak } : {}),
        ...(progress?.toolCount !== undefined ? { toolCount: progress.toolCount } : {}),
    };
}
function rememberForegroundRun(state, input) {
    state.foregroundRuns ??= new Map();
    const previous = state.foregroundRuns.get(input.runId);
    const updatedAt = Date.now();
    state.foregroundRuns.set(input.runId, {
        runId: input.runId,
        mode: input.mode,
        cwd: input.cwd,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        updatedAt,
        children: input.results.map((result, index) => {
            const resumeContract = omitUndefinedProperties({
                modelResponseAliases: input.modelResponseAliases,
                outputSchema: input.params.outputSchema,
                agentContract: input.params.agentContract,
                acceptance: input.params.acceptance,
                output: input.effectiveOutput,
                outputMode: input.effectiveOutputMode,
            });
            const child = {
                agent: result.agent,
                index,
                ...(result.sessionName ? { sessionName: result.sessionName } : {}),
                ...(result.context ? { context: result.context } : {}),
                status: resolveSubagentResultStatus(omitUndefinedProperties({
                    exitCode: result.exitCode,
                    interrupted: result.interrupted,
                    detached: result.detached,
                    processSignal: result.processSignal,
                    timedOut: result.timedOut,
                    stopped: result.stopped,
                    turnBudgetExceeded: result.turnBudgetExceeded,
                })),
                ...foregroundChildActivityFromProgress(result.progress),
                updatedAt,
                ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
                ...(result.error ? { error: result.error } : {}),
                ...(result.finalOutput ? { finalOutput: result.finalOutput } : {}),
                ...(result.outputState ? { outputState: result.outputState } : {}),
                ...(result.outputMode ? { outputMode: result.outputMode } : {}),
                ...(result.savedOutputPath ? { savedOutputPath: result.savedOutputPath } : {}),
                ...(result.outputSaveError ? { outputSaveError: result.outputSaveError } : {}),
                ...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
                ...(result.model ? { model: result.model } : {}),
                ...(result.thinking ? { thinking: result.thinking } : {}),
                ...(result.artifactPaths ? { artifactPaths: result.artifactPaths } : {}),
                ...(result.transcriptPath ? { transcriptPath: result.transcriptPath } : {}),
                ...(result.transcriptError ? { transcriptError: result.transcriptError } : {}),
                ...(result.detachedReason ? { detachedReason: result.detachedReason } : {}),
                ...(result.acceptance ? { acceptance: result.acceptance } : {}),
                ...(Object.keys(resumeContract).length ? { resumeContract } : {}),
                ...(result.launchContractDigest ? { launchContractDigest: result.launchContractDigest } : {}),
                ...(input.extensionBindings ? { extensionBindings: input.extensionBindings } : {}),
                ...(input.requiredExtensions?.length ? { requiredExtensions: input.requiredExtensions } : {}),
                ...(result.launchResolvedExtensions ? { launchResolvedExtensions: result.launchResolvedExtensions } : {}),
                ...(result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: result.runtimeAcknowledgedExtensions } : {}),
                ...(result.capabilityCeiling ? { capabilityCeiling: result.capabilityCeiling } : {}),
                ...(result.capabilityAudit ? { capabilityAudit: result.capabilityAudit } : {}),
            };
            const recovered = previous?.children[index];
            return child.status === "detached" && recovered && recovered.status !== "detached" ? recovered : child;
        }),
    });
    trimRememberedForegroundRuns(state);
    persistRememberedForegroundRuns(state);
}
function applyControlEventToRememberedForegroundRun(state, event) {
    const run = state.foregroundRuns?.get(event.runId);
    if (!run)
        return;
    const index = event.index ?? (run.children.length === 1 ? run.children[0]?.index : undefined);
    if (index === undefined)
        return;
    const child = run.children[index];
    if (!child || child.status !== "detached")
        return;
    const updatedAt = event.ts;
    run.updatedAt = updatedAt;
    run.children[index] = {
        ...child,
        activityState: event.to,
        updatedAt,
        ...(event.elapsedMs !== undefined ? { lastActivityAt: event.ts - event.elapsedMs } : {}),
        ...(event.currentTool ? { currentTool: event.currentTool } : {}),
        ...(event.currentToolDurationMs !== undefined ? { currentToolStartedAt: event.ts - event.currentToolDurationMs } : {}),
        ...(event.currentPath ? { currentPath: event.currentPath } : {}),
        ...(event.turns !== undefined ? { turnCount: event.turns } : {}),
        ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
        ...(event.toolCount !== undefined ? { toolCount: event.toolCount } : {}),
    };
}
function updateRememberedForegroundChild(state, input) {
    state.foregroundRuns ??= new Map();
    const updatedAt = Date.now();
    let run = state.foregroundRuns.get(input.runId);
    if (!run) {
        run = { runId: input.runId, mode: input.mode, cwd: input.cwd, ...(input.sessionId ? { sessionId: input.sessionId } : {}), updatedAt, children: [] };
        state.foregroundRuns.set(input.runId, run);
    }
    run.updatedAt = updatedAt;
    const terminalStatus = resolveSubagentResultStatus(omitUndefinedProperties({
        exitCode: input.result.exitCode,
        ...(input.result.acceptance?.status === "rejected" ? { success: false } : {}),
        interrupted: input.result.interrupted,
        detached: false,
        processSignal: input.result.processSignal,
        timedOut: input.result.timedOut,
        stopped: input.result.stopped,
        turnBudgetExceeded: input.result.turnBudgetExceeded,
    }));
    const child = run.children[input.index] ?? { agent: input.result.agent, index: input.index, status: "detached" };
    run.children[input.index] = omitUndefinedProperties({
        ...child,
        agent: input.result.agent,
        index: input.index,
        ...(input.result.context ? { context: input.result.context } : {}),
        status: terminalStatus,
        ...foregroundChildActivityFromProgress(input.result.progress),
        updatedAt,
        ...(input.result.exitCode !== undefined ? { exitCode: input.result.exitCode } : {}),
        ...(input.result.error ? { error: input.result.error } : {}),
        ...(input.result.finalOutput ? { finalOutput: input.result.finalOutput } : {}),
        outputState: input.result.outputState,
        outputMode: input.result.outputMode,
        savedOutputPath: input.result.savedOutputPath,
        outputSaveError: input.result.outputSaveError,
        ...(input.result.sessionFile ? { sessionFile: input.result.sessionFile } : {}),
        ...(input.result.model ? { model: input.result.model } : {}),
        ...(input.result.thinking ? { thinking: input.result.thinking } : {}),
        ...(input.result.artifactPaths ? { artifactPaths: input.result.artifactPaths } : {}),
        ...(input.result.transcriptPath ? { transcriptPath: input.result.transcriptPath } : {}),
        ...(input.result.transcriptError ? { transcriptError: input.result.transcriptError } : {}),
        ...(input.result.detachedReason ? { detachedReason: input.result.detachedReason } : {}),
        ...(input.result.acceptance ? { acceptance: input.result.acceptance } : {}),
        ...(input.result.launchContractDigest ? { launchContractDigest: input.result.launchContractDigest } : {}),
        ...(input.result.launchResolvedExtensions ? { launchResolvedExtensions: input.result.launchResolvedExtensions } : {}),
        ...(input.result.runtimeAcknowledgedExtensions ? { runtimeAcknowledgedExtensions: input.result.runtimeAcknowledgedExtensions } : {}),
        ...(input.result.capabilityCeiling ? { capabilityCeiling: input.result.capabilityCeiling } : {}),
        ...(input.result.capabilityAudit ? { capabilityAudit: input.result.capabilityAudit } : {}),
    });
    trimRememberedForegroundRuns(state);
    persistRememberedForegroundRuns(state);
    const output = getSingleResultOutput(input.result).trim();
    const success = terminalStatus === "completed";
    const summary = !success && input.result.error
        ? `${input.result.error}${output ? `\n\nOutput:\n${output}` : ""}`
        : output || input.result.error || "Detached child exited without final output.";
    // A detached callback may outlive its extension runtime. Stale sessions are
    // intentionally dropped rather than routed through a replacement runtime.
    if (input.notify === false || !input.sessionId || input.sessionId !== state.currentSessionId)
        return;
    input.events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, {
        id: `${input.runId}:${input.index}`,
        runId: input.runId,
        source: "foreground",
        mode: input.mode,
        agent: input.result.agent,
        success,
        summary,
        exitCode: input.result.exitCode,
        state: terminalStatus === "completed" ? "complete" : terminalStatus,
        ...(input.result.interrupted !== undefined ? { interrupted: input.result.interrupted } : {}),
        ...(input.result.stopped !== undefined ? { stopped: input.result.stopped } : {}),
        ...(input.result.processSignal !== undefined ? { processSignal: input.result.processSignal } : {}),
        ...(input.result.timedOut !== undefined ? { timedOut: input.result.timedOut } : {}),
        ...(input.result.turnBudgetExceeded !== undefined ? { turnBudgetExceeded: input.result.turnBudgetExceeded } : {}),
        timestamp: updatedAt,
        cwd: input.cwd,
        sessionFile: input.result.sessionFile,
        sessionId: input.sessionId,
        taskIndex: input.index,
    });
}
function resolveForegroundResumeTarget(params, state, options = {}) {
    const requested = (params.id ?? params.runId)?.trim();
    if (!requested || !state.foregroundRuns?.size || !state.currentSessionId)
        return undefined;
    const direct = state.foregroundRuns.get(requested);
    const matches = direct?.sessionId === state.currentSessionId
        ? [direct]
        : options.exactOnly ? [] : [...state.foregroundRuns.values()].filter((run) => run.sessionId === state.currentSessionId && run.runId.startsWith(requested));
    if (matches.length === 0)
        return undefined;
    if (matches.length > 1)
        throw new Error(`Ambiguous foreground run id prefix '${requested}' matched: ${matches.map((run) => run.runId).join(", ")}. Provide a longer id.`);
    const run = matches[0];
    if (run.children.some((child) => child.status === "detached"))
        throw new Error(`Foreground run '${run.runId}' is detached for intercom coordination and cannot be revived safely while any child may still be live. Reply to the supervisor request first, then wait with bg_wait({ id: "${run.runId}" }); use status to recover the result and do not launch a replacement while it remains detached.`);
    if (run.children.length > 1 && params.index === undefined)
        throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Provide index to choose one.`);
    const index = params.index ?? 0;
    if (!Number.isInteger(index))
        throw new Error(`Foreground run '${run.runId}' index must be an integer.`);
    if (index < 0 || index >= run.children.length)
        throw new Error(`Foreground run '${run.runId}' has ${run.children.length} children. Index ${index} is out of range.`);
    const child = run.children[index];
    if (!child.sessionFile)
        throw new Error(`Foreground run '${run.runId}' child ${index} does not have a persisted session file to resume from.`);
    if (path.extname(child.sessionFile) !== ".jsonl")
        throw new Error(`Foreground run '${run.runId}' child ${index} session file must be a .jsonl file: ${child.sessionFile}`);
    const sessionFile = path.resolve(child.sessionFile);
    if (!fs.existsSync(sessionFile))
        throw new Error(`Foreground run '${run.runId}' child ${index} session file does not exist: ${child.sessionFile}`);
    return {
        runId: run.runId,
        mode: run.mode,
        state: "complete",
        agent: child.agent,
        index,
        cwd: run.cwd,
        sessionFile,
        ...(child.model ? { model: child.model } : {}),
        ...(child.thinking ? { thinking: child.thinking } : {}),
        ...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
        ...(child.resumeContract ? { resumeContract: child.resumeContract } : {}),
        ...(child.extensionBindings ? { extensionBindings: normalizeExtensionBindings(child.extensionBindings).value } : {}),
        ...(child.requiredExtensions ? { requiredExtensions: child.requiredExtensions } : {}),
        ...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
    };
}
function isAsyncRunNotFound(error) {
    return error instanceof Error && error.message.startsWith("Async run not found.");
}
function isMissingExactAsyncStatusFile(error, requested) {
    return error instanceof Error && error.message === `Status file not found for async run '${requested}'.`;
}
function isResumeAmbiguity(error) {
    return error instanceof Error && /Ambiguous .*run id prefix/.test(error.message);
}
function resumeTargetExact(target, requested) {
    return target?.runId === requested;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function isExactResumeError(error, source, requested) {
    if (!(error instanceof Error) || !requested)
        return false;
    return new RegExp(`\\b${source} run '${escapeRegExp(requested)}'`, "i").test(error.message);
}
function resolveResumeTarget(params, state, options = {}) {
    const requested = (params.id ?? params.runId)?.trim() ?? "";
    let foregroundTarget;
    let foregroundError;
    let asyncTarget;
    let asyncError;
    try {
        const target = resolveForegroundResumeTarget(params, state, options);
        if (target)
            foregroundTarget = { kind: "revive", source: "foreground", ...target };
    }
    catch (error) {
        foregroundError = error;
    }
    try {
        const asyncParams = options.exactOnly && requested && !params.dir
            ? { ...params, dir: path.join(DIRS.async, requested) }
            : params;
        asyncTarget = {
            source: "async",
            ...resolveAsyncResumeTarget(asyncParams, {}, compactOptional({
                requireSessionFile: options.asyncRequireSessionFile,
                sessionId: state.currentSessionId ?? undefined,
            })),
        };
    }
    catch (error) {
        asyncError = error;
    }
    if (foregroundTarget && asyncTarget) {
        const foregroundExact = resumeTargetExact(foregroundTarget, requested);
        const asyncExact = resumeTargetExact(asyncTarget, requested);
        if (foregroundExact && !asyncExact)
            return foregroundTarget;
        if (asyncExact && !foregroundExact)
            return asyncTarget;
        throw new Error(`Resume id '${requested}' is ambiguous between foreground run '${foregroundTarget.runId}' and async run '${asyncTarget.runId}'. Provide a full run id.`);
    }
    if (foregroundTarget) {
        if (isExactResumeError(asyncError, "async", requested) && !isMissingExactAsyncStatusFile(asyncError, requested))
            throw asyncError;
        if (isResumeAmbiguity(asyncError) && !resumeTargetExact(foregroundTarget, requested))
            throw asyncError;
        return foregroundTarget;
    }
    if (asyncTarget) {
        if (isExactResumeError(foregroundError, "foreground", requested))
            throw foregroundError;
        if (isResumeAmbiguity(foregroundError) && !resumeTargetExact(asyncTarget, requested))
            throw foregroundError;
        return asyncTarget;
    }
    if (foregroundError && !isAsyncRunNotFound(asyncError))
        throw foregroundError;
    if (foregroundError)
        throw foregroundError;
    if (asyncError)
        throw asyncError;
    throw new Error("Run not found. Provide id or runId.");
}
function getAsyncInterruptTarget(state, runId, location, options = {}) {
    if (location?.asyncDir) {
        return {
            asyncId: location.resolvedId ?? runId ?? path.basename(location.asyncDir),
            asyncDir: location.asyncDir,
        };
    }
    if (runId) {
        const direct = state.asyncJobs.get(runId);
        if (direct)
            return { asyncId: direct.asyncId, asyncDir: direct.asyncDir };
        if (options.fallbackToNewest === false)
            return undefined;
    }
    let newest;
    for (const job of state.asyncJobs.values()) {
        if (job.status !== "running")
            continue;
        if (!newest || (job.updatedAt ?? 0) > newest.updatedAt) {
            newest = { asyncId: job.asyncId, asyncDir: job.asyncDir, updatedAt: job.updatedAt ?? 0 };
        }
    }
    return newest ? { asyncId: newest.asyncId, asyncDir: newest.asyncDir } : undefined;
}
function isStaleExtensionContextError(error) {
    if (!(error instanceof Error))
        return false;
    return /extension ctx is stale|stale after session replacement or reload/i.test(error.message);
}
function emitAdvisoryControlEvent(pi, channel, payload) {
    try {
        pi.events.emit(channel, payload);
    }
    catch (error) {
        if (isStaleExtensionContextError(error))
            return;
        throw error;
    }
}
function persistAsyncWorkflowControlEvent(input) {
    const channels = input.event.type === "active_long_running"
        ? input.controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
        : input.controlConfig.notifyChannels;
    if (channels.length === 0)
        return;
    const record = {
        ts: Date.now(),
        runId: input.job.asyncId,
        type: "subagent.control",
        event: input.event,
        channels,
        childIntercomTarget: input.childIntercomTarget,
        noticeText: formatControlNoticeMessage(input.event, input.childIntercomTarget),
        ...(input.intercomBridge.active && input.intercomBridge.orchestratorTarget && channels.includes("intercom")
            ? {
                intercom: {
                    to: input.intercomBridge.orchestratorTarget,
                    message: formatControlIntercomMessage(input.event, input.childIntercomTarget),
                },
            }
            : {}),
    };
    try {
        fs.appendFileSync(path.join(input.job.asyncDir, "events.jsonl"), `${JSON.stringify(record)}\n`, "utf-8");
    }
    catch (error) {
        if (!isStorageCapacityError(error))
            throw error;
        console.error("Failed to append async workflow control event while storage is full:", error);
    }
}
function emitControlNotification(input) {
    if (!shouldNotifyControlEvent(input.controlConfig, input.event))
        return;
    const childIntercomTarget = input.intercomBridge.active
        ? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
        : undefined;
    const payload = {
        event: input.event,
        source: input.source ?? "foreground",
        childIntercomTarget,
        noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
    };
    if (input.controlConfig.notifyChannels.includes("event")) {
        emitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_EVENT, payload);
    }
    if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
        emitAdvisoryControlEvent(input.pi, SUBAGENT_CONTROL_INTERCOM_EVENT, {
            ...payload,
            to: input.intercomBridge.orchestratorTarget,
            message: formatControlIntercomMessage(input.event, childIntercomTarget),
        });
    }
}
function interruptAsyncRun(state, runId, kill, location) {
    const target = getAsyncInterruptTarget(state, runId, location);
    if (!target)
        return null;
    const status = reconcileAsyncRun(target.asyncDir, omitUndefinedProperties({ kill })).status;
    if (!status || status.state !== "running" || typeof status.pid !== "number") {
        return {
            content: [{ type: "text", text: `No running async run with an interrupt-capable pid was found for '${runId ?? "current"}'.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const activeSteps = status.steps?.filter((step) => step.status === "running") ?? [];
    if (activeSteps.length > 0 && activeSteps.every((step) => step.runner?.type === "external-cli" || step.runner?.type === "external-job")) {
        return {
            content: [{ type: "text", text: `Interrupt is unsupported for external async run ${target.asyncId}; use stop instead.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (status.mode === "workflow") {
        return {
            content: [{ type: "text", text: `Interrupt is unsupported for async workflow ${target.asyncId}; use stop instead.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    try {
        deliverInterruptRequest({ asyncDir: target.asyncDir, source: "interrupt-action" });
        const tracked = state.asyncJobs.get(target.asyncId);
        if (tracked) {
            delete tracked.activityState;
            tracked.updatedAt = Date.now();
        }
        return {
            content: [{ type: "text", text: `Interrupt requested for async run ${target.asyncId}.` }],
            details: { mode: "management", results: [] },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Failed to interrupt async run ${target.asyncId}: ${message}` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
}
function duplicateNames(names) {
    const seen = new Set();
    const duplicates = new Set();
    for (const name of names) {
        if (seen.has(name))
            duplicates.add(name);
        else
            seen.add(name);
    }
    return [...duplicates];
}
function appendStepToAsyncChain(input) {
    const targetRunId = input.params.id ?? input.params.runId;
    if (!targetRunId) {
        return {
            content: [{ type: "text", text: "action='append-step' requires id." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (!input.params.step) {
        return {
            content: [{ type: "text", text: "action='append-step' requires step." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const chain = [input.params.step];
    const validationParams = { ...input.params, chain };
    const acceptancePolicyErrors = validateExecutionAcceptancePolicy(validationParams);
    const outputSchemaError = validateLaunchOutputSchemaOverrides(validationParams);
    const earlyErrors = [...acceptancePolicyErrors];
    if (outputSchemaError)
        earlyErrors.push(outputSchemaError);
    if (earlyErrors.length > 0) {
        return {
            content: [{ type: "text", text: `Cannot append step: ${earlyErrors.join(" ")}` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    let resolved;
    try {
        resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: input.deps.state, nested: nestedResolutionScopeForExecutor(input.deps) }));
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
    }
    if (!resolved) {
        return {
            content: [{ type: "text", text: `No async chain run found for '${targetRunId}'.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (resolved.kind !== "async" || !resolved.location.asyncDir) {
        return {
            content: [{ type: "text", text: `Run '${resolved.id}' is not an append-capable async chain run.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const status = readStatus(resolved.location.asyncDir);
    if (!status) {
        return {
            content: [{ type: "text", text: `No async run status found for '${resolved.id}'.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (status.mode !== "chain") {
        return {
            content: [{ type: "text", text: `Run '${resolved.id}' is ${status.mode}; only active chain runs accept appended steps.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (status.state !== "running") {
        return {
            content: [{ type: "text", text: `Run '${resolved.id}' is ${status.state}; only running chain runs accept appended steps.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const stillInProgress = (status.steps ?? []).some((step) => step.status === "running" || step.status === "pending") || (status.pendingAppends ?? 0) > 0;
    if (!stillInProgress) {
        return {
            content: [{ type: "text", text: `Run '${resolved.id}' has no running or pending chain steps left; append-step must target an in-progress chain.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const pendingAppendRequests = readPendingChainAppendRequests(resolved.location.asyncDir);
    const reservedOutputNames = new Set([
        ...Object.keys(status.outputs ?? {}),
        ...(status.steps ?? []).map((step) => step.outputName).filter((name) => Boolean(name)),
        ...pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)),
    ]);
    try {
        validateChainOutputBindingsWithContext(chain, omitUndefinedProperties({ maxItems: input.deps.config.chain?.dynamicFanout?.maxItems }), {
            priorOutputNames: reservedOutputNames,
            startStepIndex: status.chainStepCount ?? status.steps?.length ?? 0,
        });
    }
    catch (error) {
        if (!(error instanceof ChainOutputValidationError))
            throw error;
        return {
            content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': ${error.message}` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const scope = resolveExecutionAgentScope(input.params.agentScope);
    const discoveredForAppend = input.deps.discoverAgents(input.requestCwd, scope, input.parentModel?.provider);
    const agents = discoveredForAppend.agents;
    const acceptanceErrors = validateExecutionAcceptance(projectEffectiveAcceptanceSchemas(validationParams, agents));
    if (acceptanceErrors.length > 0) {
        return {
            content: [{ type: "text", text: `Cannot append step: ${acceptanceErrors.join(" ")}` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const contextPolicy = resolveExplicitContextPolicy(input.params);
    const chainSkillInput = normalizeSkillInput(input.params.skill);
    const chainSkills = chainSkillInput === false ? [] : (chainSkillInput ?? []);
    const parentModel = input.parentModel;
    const asyncCtx = compactOptional({
        pi: input.deps.pi,
        cwd: input.ctx.cwd,
        currentSessionId: resolveCurrentSessionId(input.ctx.sessionManager),
        parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
        currentModelProvider: parentModel?.provider,
        currentModel: parentModel,
        scopedModelIds: scopedModelIdsFromContext(input.ctx),
        modelScope: discoveredForAppend.modelScope,
        modelResponseAliases: input.deps.config.modelResponseAliases,
        interactive: input.ctx.hasUI,
        permissions: input.deps.config.permissions,
        childRuntime: input.deps.childRuntime,
    });
    const built = buildAsyncRunnerSteps(resolved.id, compactOptional({
        chain: wrapChainTasksForFork(chain, contextPolicy),
        task: input.params.task,
        resultMode: "chain",
        agents,
        ctx: asyncCtx,
        availableModels: input.ctx.modelRegistry.getAvailable().map(toModelInfo),
        unknownAgentDiagnosticContext: diagnosticContextFromDiscovery(discoveredForAppend, input.requestCwd, scope),
        cwd: status.cwd ?? input.requestCwd,
        chainSkills,
        dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
        maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime),
        waitToolEnabled: input.deps.waitToolEnabled,
        waitToolDefaultTimeoutMs: input.deps.waitToolDefaultTimeoutMs,
        contextForAgent: contextPolicy.contextForAgent,
        worktreeBaseDir: input.deps.config.worktreeBaseDir,
        worktreeProvider: input.deps.config.worktreeProvider,
        worktreeBranchPrefix: input.deps.config.worktreeBranchPrefix,
        asyncDir: resolved.location.asyncDir,
        validateOutputBindings: false,
        capabilityCeiling: intersectSubagentCapabilityCeilings(status.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(asyncCtx.currentSessionId)),
    }));
    if ("error" in built) {
        return {
            content: [{ type: "text", text: built.error }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const appendedOutputNames = runnerStepOutputNames(built.steps);
    const duplicateAppendedOutputs = duplicateNames(appendedOutputNames);
    if (duplicateAppendedOutputs.length > 0) {
        return {
            content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': duplicate output name in appended step: ${duplicateAppendedOutputs.join(", ")}.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const pendingOutputNames = new Set(pendingAppendRequests.flatMap((request) => runnerStepOutputNames(request.steps)));
    const pendingDuplicateOutputs = appendedOutputNames.filter((name) => pendingOutputNames.has(name));
    if (pendingDuplicateOutputs.length > 0) {
        return {
            content: [{ type: "text", text: `Cannot append step to run '${resolved.id}': output name already belongs to a pending append: ${pendingDuplicateOutputs.join(", ")}.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    try {
        const asyncDir = resolved.location.asyncDir;
        if (!asyncDir)
            throw new Error(`Run '${resolved.id}' is missing its async directory.`);
        const runFanoutBudget = readRunFanoutBudgetDescriptor(asyncDir);
        if (!runFanoutBudget)
            throw new Error(`Run '${resolved.id}' is missing its run fan-out budget identity.`);
        const startIndex = (status.chainStepCount ?? status.steps?.length ?? 0) + pendingAppendRequests.reduce((total, request) => total + request.steps.length, 0);
        const appendPaths = chain.flatMap((step, localIndex) => {
            const absoluteIndex = startIndex + localIndex;
            if (isDynamicParallelStep(step))
                return [];
            if (isParallelStep(step))
                return step.parallel.map((_, itemIndex) => `chain[${absoluteIndex}].parallel[${itemIndex}]`);
            return [`chain[${absoluteIndex}]`];
        });
        const result = enqueueChainAppendRequest({
            asyncDir,
            runId: resolved.id,
            steps: built.steps,
            admit: (persist) => claimRunFanoutBatchWithCommit(runFanoutBudget, appendPaths, persist),
        });
        const stepText = built.steps.length === 1 ? "step" : "steps";
        return {
            content: [{
                    type: "text",
                    text: `Append queued for chain run ${resolved.id}: ${built.steps.length} ${stepText}. It becomes eligible after the chain's already-queued steps finish. Pending appends: ${result.pendingCount}.${result.bookkeepingError ? ` Bookkeeping warning: ${result.bookkeepingError}` : ""}`,
                }],
            details: { mode: "management", results: [], asyncId: resolved.id, asyncDir },
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            content: [{ type: "text", text: `Failed to append step to chain run ${resolved.id}: ${message}` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
}
function nestedRunSessionFile(run) {
    return run.sessionFile ?? (run.steps?.length === 1 ? run.steps[0]?.sessionFile : undefined);
}
function nestedRunAgent(run) {
    return run.agent ?? run.agents?.[0] ?? (run.steps?.length === 1 ? run.steps[0]?.agent : undefined);
}
function pathWithin(base, candidate) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}
function validateNestedSessionFile(run, trustedSessionRoots) {
    const sessionFile = nestedRunSessionFile(run);
    if (!sessionFile)
        throw new Error(`Nested run '${run.id}' does not have a persisted session file to resume from.`);
    if (path.extname(sessionFile) !== ".jsonl")
        throw new Error(`Nested run '${run.id}' session file must be a .jsonl file: ${sessionFile}`);
    const resolved = path.resolve(sessionFile);
    if (!path.isAbsolute(sessionFile))
        throw new Error(`Nested run '${run.id}' session file must be absolute: ${sessionFile}`);
    if (!fs.existsSync(resolved))
        throw new Error(`Nested run '${run.id}' session file does not exist: ${sessionFile}`);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Nested run '${run.id}' session file is not a regular file: ${sessionFile}`);
    const realSessionFile = fs.realpathSync(resolved);
    const trustedRoots = trustedSessionRoots
        .filter((root) => fs.existsSync(root))
        .map((root) => fs.realpathSync(root));
    if (!trustedRoots.some((root) => pathWithin(root, realSessionFile))) {
        throw new Error(`Nested run '${run.id}' session file is outside trusted nested session roots: ${sessionFile}`);
    }
    if (!realSessionFile.split(path.sep).includes(run.id)) {
        throw new Error(`Nested run '${run.id}' session file is not under that nested run's session directory: ${sessionFile}`);
    }
    return realSessionFile;
}
export function readNestedRecoveryDescriptor(asyncDir, runId, agent) {
    const recoveryDescriptor = readAsyncRecoveryDescriptor(asyncDir);
    if (!recoveryDescriptor)
        return undefined;
    if (recoveryDescriptor.sourceRunId !== runId)
        throw new Error(`Nested run '${runId}' has a recovery descriptor for a different source run.`);
    if (recoveryDescriptor.agent !== agent)
        throw new Error(`Nested run '${runId}' has a recovery descriptor for a different agent.`);
    return recoveryDescriptor;
}
function resolveNestedResumeTarget(match, trustedSessionRoots) {
    const run = match.match.run;
    if (run.state === "running" || run.state === "queued")
        throw new Error(`Nested run '${run.id}' is live; route the follow-up to the owner process instead.`);
    if (run.state === "stopped")
        throw new Error(`Nested run '${run.id}' was stopped and cannot be resumed. Start a new run instead.`);
    const agent = nestedRunAgent(run);
    if (!agent)
        throw new Error(`Could not determine child agent for nested run '${run.id}'.`);
    const state = run.state === "complete" || run.state === "failed" || run.state === "paused" ? run.state : "failed";
    const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
    const recoveryDescriptor = readNestedRecoveryDescriptor(asyncDir, run.id, agent);
    return compactOptional({
        kind: "revive",
        source: "nested",
        runId: run.id,
        state,
        agent,
        index: 0,
        cwd: asyncDir ? path.dirname(asyncDir) : undefined,
        sessionFile: validateNestedSessionFile(run, trustedSessionRoots),
        ...(run.capabilityCeiling ? { capabilityCeiling: run.capabilityCeiling } : {}),
        ...(recoveryDescriptor ? { recoveryDescriptor } : {}),
    });
}
function resolveNestedExternalJobResumeTarget(match, params, deps) {
    const run = match.match.run;
    if (run.state === "stopped")
        return undefined;
    const asyncDir = resolveNestedAsyncDir(match.match.rootRunId, run);
    if (!asyncDir)
        return undefined;
    const status = readNestedRunStatus(asyncDir, run);
    const steps = status?.steps ?? [];
    const step = steps[params.index ?? 0];
    if (!step) {
        // An index outside an external-job run gets the async resolver's index error instead of a Pi revive.
        if (params.index === undefined || !steps.some((candidate) => candidate.runner?.type === "external-job"))
            return undefined;
    }
    else if (!step.runner) {
        // Pi steps record no runner, and neither does a launch status before the runner starts.
        // A session file means a Pi run; otherwise the agent definition says what the step runs.
        if (nestedRunSessionFile(run))
            return undefined;
        const agent = deps.discoverAgents(status?.cwd ?? deps.state.baseCwd, resolveExecutionAgentScope(params.agentScope)).agents.find((candidate) => candidate.name === step.agent);
        if (agent?.runner?.type === "external-job")
            throw new Error(externalJobWithoutMetadataMessage(run.id));
        return undefined;
    }
    else if (step.runner.type !== "external-job") {
        return undefined;
    }
    // External-job runs have no Pi session, so resume them as a provider follow-up from their own run directory.
    const target = resolveAsyncResumeTarget(compactOptional({ dir: asyncDir, index: params.index }), nestedRunScope(match.match.rootRunId), { requireSessionFile: false });
    if (target.kind === "live")
        throw new Error(externalJobStillRunningMessage(target.runId));
    return { source: "async", ...target };
}
function readNestedRunStatus(asyncDir, run) {
    try {
        return readStatus(asyncDir);
    }
    catch (error) {
        // A nested Pi run revives from its session file, so its unreadable status file must not block it.
        if (nestedRunSessionFile(run))
            return null;
        throw error;
    }
}
function externalJobStillRunningMessage(runId) {
    return `External-job run '${runId}' is still running. Wait for completion, then use subagent({ action: "resume", id: "${runId}", message: "..." }).`;
}
function externalJobWithoutMetadataMessage(runId) {
    return `External-job run '${runId}' has no persisted provider metadata. Cannot follow up without the parent provider job id.`;
}
async function waitForNestedControlResult(target, requestId, ignoredFiles, timeoutMs = 1_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const result = findNestedControlResult(target.match.route, requestId, target.match.run.id, ignoredFiles);
        if (result)
            return result;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return undefined;
}
async function sendNestedControlRequest(target, action, message) {
    const requestId = randomUUID();
    const ignoredFiles = snapshotNestedEventFiles(target.match.route);
    const requestedAt = Date.now();
    writeNestedControlRequest(target.match.route, {
        ts: requestedAt,
        requestId,
        targetRunId: target.match.run.id,
        action,
        ...(message ? { message } : {}),
    });
    return waitForNestedControlResult(target, requestId, ignoredFiles);
}
function directNestedAsyncInterrupt(target) {
    const run = target.match.run;
    const asyncDir = resolveNestedAsyncDir(target.match.rootRunId, run);
    if (!asyncDir)
        return undefined;
    const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(DIRS.results, "nested", target.match.rootRunId) }).status;
    const pid = typeof status?.pid === "number" && status.pid > 0 ? status.pid : run.pid;
    if (!status || status.state !== "running" || typeof pid !== "number" || pid <= 0)
        return undefined;
    try {
        deliverInterruptRequest({ asyncDir, source: "nested-interrupt" });
        return { content: [{ type: "text", text: `Interrupt requested for nested async run ${run.id}.` }], details: { mode: "management", results: [] } };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Failed to interrupt nested async run ${run.id}: ${message}` }], isError: true, details: { mode: "management", results: [] } };
    }
}
async function directNestedAsyncSteer(input) {
    const run = input.target.match.run;
    const asyncDir = resolveNestedAsyncDir(input.target.match.rootRunId, run);
    if (!asyncDir)
        return undefined;
    const status = reconcileAsyncRun(asyncDir, { resultsDir: path.join(DIRS.results, "nested", input.target.match.rootRunId) }).status;
    if (!status || (status.state !== "running" && status.state !== "queued"))
        return undefined;
    const steps = status.steps ?? [];
    if (input.index !== undefined) {
        if (input.index < 0 || input.index >= steps.length)
            return { content: [{ type: "text", text: `Nested async run ${run.id} has ${steps.length} children. Index ${input.index} is out of range.` }], isError: true, details: { mode: "management", results: [] } };
        const step = steps[input.index];
        if (step && step.status !== "running" && step.status !== "pending")
            return { content: [{ type: "text", text: `Nested async run ${run.id} child ${input.index} is ${step.status} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
    }
    const runningIndexes = steps
        .map((step, index) => step.status === "running" ? index : undefined)
        .filter((index) => index !== undefined);
    const effectiveTargetIndex = input.index ?? (status.mode === "single" && runningIndexes.length === 0 && steps[0]?.status === "pending" ? 0 : undefined);
    const targetIndexes = effectiveTargetIndex !== undefined ? [effectiveTargetIndex] : runningIndexes;
    if (targetIndexes.length === 0)
        return { content: [{ type: "text", text: `Nested async run ${run.id} has no running child to steer.` }], isError: true, details: { mode: "management", results: [] } };
    const requestId = randomUUID();
    try {
        requestAsyncSteer(asyncDir, {
            message: input.message,
            mode: input.mode,
            ...(effectiveTargetIndex !== undefined ? { targetIndex: effectiveTargetIndex } : { targetIndexes }),
            source: "nested-steer",
            id: requestId,
        });
    }
    catch (error) {
        return { content: [{ type: "text", text: `Failed to queue steering for nested async run ${run.id}: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "management", results: [] } };
    }
    const targets = targetIndexes.map((index) => ({ index, state: steps[index]?.status === "pending" ? "scheduled" : "pending" }));
    if (targets.every((target) => target.state === "scheduled")) {
        const scheduled = { requestId, state: "scheduled", deliveryStatus: "queued", sourceRunId: run.id, targets };
        return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering scheduled for nested async run ${run.id} (request ${requestId}).`) }], details: { mode: "management", results: [], steering: scheduled } };
    }
    const waited = await waitForSteeringAction(omitUndefinedProperties({ asyncDir, sourceRunId: run.id, requestId, timeoutMs: 3_000, signal: input.signal }));
    const result = waited ?? { requestId, state: "pending", deliveryStatus: "queued", sourceRunId: run.id, targets };
    const stateText = result.state === "failed" ? "failed" : result.state === "partial" ? "partial" : result.deliveryStatus === "queued" ? "queued" : result.state === "delivered" ? "delivered" : "pending";
    return { content: [{ type: "text", text: steeringReceipt(input.message, `Steering ${stateText} for nested async run ${run.id} (request ${requestId}).`) }], ...(result.state === "failed" || result.state === "partial" ? { isError: true } : {}), details: { mode: "management", results: [], steering: result } };
}
async function interruptNestedRun(target) {
    const run = target.match.run;
    if (run.state === "complete")
        return { content: [{ type: "text", text: `Nested run ${run.id} is already complete and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
    if (run.state === "failed")
        return { content: [{ type: "text", text: `Nested run ${run.id} has failed and cannot be interrupted.` }], isError: true, details: { mode: "management", results: [] } };
    if (run.state === "paused")
        return { content: [{ type: "text", text: `Nested run ${run.id} is already paused.` }], isError: true, details: { mode: "management", results: [] } };
    const result = await sendNestedControlRequest(target, "interrupt");
    if (result)
        return { content: [{ type: "text", text: result.message }], ...(result.ok ? {} : { isError: true }), details: { mode: "management", results: [] } };
    const direct = directNestedAsyncInterrupt(target);
    if (direct)
        return direct;
    return { content: [{ type: "text", text: `Nested run ${run.id} owner is not reachable and no safe direct async interrupt fallback is available.` }], isError: true, details: { mode: "management", results: [] } };
}
async function resumeLiveNestedRun(input) {
    const run = input.target.match.run;
    const result = await sendNestedControlRequest(input.target, "resume", input.message);
    if (result)
        return { content: [{ type: "text", text: result.message }], ...(result.ok ? {} : { isError: true }), details: { mode: "management", results: [] } };
    return { content: [{ type: "text", text: `Nested run ${run.id} appears live but its owner route is not reachable. Wait for completion, then retry action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
}
async function steerNestedRun(input) {
    const run = input.target.match.run;
    if (run.state !== "running" && run.state !== "queued")
        return { content: [{ type: "text", text: `Nested run ${run.id} is ${run.state} and cannot be steered.` }], isError: true, details: { mode: "management", results: [] } };
    const direct = await directNestedAsyncSteer(input);
    if (direct)
        return direct;
    return { content: [{ type: "text", text: `Nested run ${run.id} is not a live async Pi child session with a steering inbox. action='steer' cannot target foreground nested runs.` }], isError: true, details: { mode: "management", results: [] } };
}
function externalJobOptionsEqual(left, right) {
    return externalJobStableJson(left) === externalJobStableJson(right);
}
function providerFollowUpSupport(providerName) {
    try {
        const provider = getExternalJobProvider(providerName);
        if (!provider)
            return { ok: false, message: `External-job provider '${providerName}' is not registered. Load the provider package, then retry action='resume'.` };
        if (typeof provider.followUp !== "function")
            return { ok: false, message: `External-job provider '${providerName}' does not support follow-up. Update or reload the provider package, then retry action='resume'.` };
        return { ok: true };
    }
    catch (error) {
        return { ok: false, message: `External-job provider registry unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
}
function externalJobFollowUpStarted(input) {
    const lines = [
        input.duplicate ? `External-job follow-up already exists for ${input.sourceRunId}.` : `Started external-job follow-up for ${input.sourceRunId}.`,
        `Follow-up run: ${input.runId}`,
        `Async dir: ${input.asyncDir}`,
        `Status if needed: subagent({ action: "status", id: "${input.runId}" })`,
    ];
    return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.interactive) }], details: { mode: "single", results: [], asyncId: input.runId, asyncDir: input.asyncDir } };
}
function externalRunnerControlError(asyncDir, action) {
    const status = readStatus(asyncDir);
    if (!status?.steps?.length || !status.steps.every((step) => step.runner?.type === "external-cli" || step.runner?.type === "external-job"))
        return undefined;
    const externalCli = normalizeExternalCliRunnerStatus(status.steps.find((step) => step.runner?.type === "external-cli")?.runner);
    const message = externalCli
        ? action === "steer"
            ? `External adapter '${externalCli.adapter.id}' does not support runs.steer: ${externalCli.unsupportedReasons.steer}`
            : `External adapter '${externalCli.adapter.id}' cannot resume: ${externalCli.nonResumableReason}`
        : action === "steer"
            ? "External runners do not accept live steer messages."
            : "External runners do not persist Pi sessions and cannot be resumed.";
    return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
}
async function resumeExternalJobFollowUp(input) {
    if (input.target.kind === "live" || input.target.state === "running" || input.target.state === "queued") {
        return { content: [{ type: "text", text: externalJobStillRunningMessage(input.target.runId) }], isError: true, details: { mode: "management", results: [] } };
    }
    const runner = input.target.runner;
    const externalJob = input.target.externalJob;
    if (runner?.type !== "external-job")
        return { content: [{ type: "text", text: "Internal error: external-job follow-up was requested for a non-external-job runner." }], isError: true, details: { mode: "management", results: [] } };
    if (!externalJob)
        return { content: [{ type: "text", text: externalJobWithoutMetadataMessage(input.target.runId) }], isError: true, details: { mode: "management", results: [] } };
    if (externalJob.provider !== runner.provider)
        return { content: [{ type: "text", text: `External-job run '${input.target.runId}' has mismatched provider metadata. Refusing to follow up.` }], isError: true, details: { mode: "management", results: [] } };
    if (!externalJobOptionsEqual(externalJob.options, runner.options))
        return { content: [{ type: "text", text: `External-job run '${input.target.runId}' has mismatched provider options. Refusing to follow up.` }], isError: true, details: { mode: "management", results: [] } };
    if (!externalJob.providerJobId)
        return { content: [{ type: "text", text: `External-job run '${input.target.runId}' has no parent provider job id. Cannot follow up without reopening or redispatching, so this fails closed.` }], isError: true, details: { mode: "management", results: [] } };
    if (externalJob.state !== "completed")
        return { content: [{ type: "text", text: `External-job run '${input.target.runId}' provider state is ${externalJob.state}. Wait for completion, then use action='resume'.` }], isError: true, details: { mode: "management", results: [] } };
    const support = providerFollowUpSupport(runner.provider);
    if (!support.ok)
        return { content: [{ type: "text", text: support.message }], isError: true, details: { mode: "management", results: [] } };
    const promptDigest = externalJobPromptDigest(input.followUp);
    const requestDigest = externalJobFollowUpRequestDigest({ provider: runner.provider, parentProviderJobId: externalJob.providerJobId, promptDigest, options: runner.options });
    const requestId = externalJobFollowUpRequestId(requestDigest);
    const runId = externalJobFollowUpRunId(requestDigest);
    // A child launches the follow-up under its nested route, so look for an earlier one where it would be.
    const nestedRoute = inheritedNestedRoute(input.deps);
    const runRoots = nestedRoute ? nestedRunScope(nestedRoute.rootRunId) : { asyncDirRoot: DIRS.async, resultsDir: DIRS.results };
    const asyncDir = path.join(runRoots.asyncDirRoot, runId);
    const currentSessionId = input.deps.state.currentSessionId;
    if (!currentSessionId)
        return { content: [{ type: "text", text: "External-job follow-up requires an active parent session." }], isError: true, details: { mode: "management", results: [] } };
    if (fs.existsSync(asyncDir) || fs.existsSync(resultFilePath(runRoots.resultsDir, runId))) {
        return externalJobFollowUpStarted({ sourceRunId: input.target.runId, runId, asyncDir, duplicate: true, interactive: input.ctx.hasUI });
    }
    const depthState = checkSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime);
    if (depthState.blocked) {
        return { content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depthState.depth}, max=${depthState.maxDepth}). Complete the follow-up directly instead.` }], isError: true, details: { mode: "management", results: [] } };
    }
    const topLevelResume = depthState.depth === 0 && !inheritedNestedRoute(input.deps) && !input.deps.state.workflowControllers?.has(input.target.runId);
    let activeAsyncCapacity;
    try {
        activeAsyncCapacity = topLevelResume ? acquireActiveAsyncCapacity({
            sessionId: currentSessionId,
            limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
            runId,
            kind: "runner",
            asyncDir,
        }, { liveWorkflowRunIds: new Set(input.deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(input.deps.config.capacity?.abandonedSlotReleaseAfterMs) }) : undefined;
    }
    catch (error) {
        if (error instanceof ActiveAsyncCapacityError)
            return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "single", results: [], activeAsyncCapacity: error.snapshot } };
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "single", results: [] } };
    }
    const artifactConfig = omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: true, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
    const artifactsDir = getArtifactsDir(input.parentSessionFile, input.effectiveCwd, artifactConfig.dir);
    const parentModel = input.parentModel;
    const agentConfig = {
        ...input.baseAgentConfig,
        runner: { type: "external-job", provider: runner.provider, options: runner.options },
    };
    const result = await executeAsyncSingle(runId, compactOptional({
        agent: input.target.agent,
        task: input.followUp,
        goal: input.followUp,
        agentConfig,
        recoveryAgentConfig: agentConfig,
        ctx: compactOptional({
            pi: input.deps.pi,
            cwd: input.requestCwd,
            currentSessionId,
            parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
            currentModelProvider: parentModel?.provider,
            currentModel: parentModel,
            scopedModelIds: scopedModelIdsFromContext(input.ctx),
            modelScope: input.modelScope,
            modelResponseAliases: input.deps.config.modelResponseAliases,
            interactive: input.ctx.hasUI,
            permissions: input.deps.config.permissions,
            childRuntime: input.deps.childRuntime,
            projectTrusted: sessionProjectTrust(input.ctx),
        }),
        cwd: input.effectiveCwd,
        artifactsDir,
        artifactConfig,
        shareEnabled: false,
        ...(input.parentSessionFile ? { sessionRoot: input.deps.getSubagentSessionRoot(input.parentSessionFile) } : {}),
        maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime),
        waitToolEnabled: input.deps.waitToolEnabled,
        waitToolDefaultTimeoutMs: input.deps.waitToolDefaultTimeoutMs,
        worktreeSetupHook: input.deps.config.worktreeSetupHook,
        worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
        worktreeBaseDir: input.deps.config.worktreeBaseDir,
        worktreeProvider: input.deps.config.worktreeProvider,
        worktreeBranchPrefix: input.deps.config.worktreeBranchPrefix,
        controlConfig: resolveControlConfig(input.deps.config.control, undefined),
        controlIntercomTarget: input.intercomBridge.active ? input.intercomBridge.orchestratorTarget : undefined,
        childIntercomTarget: input.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
        availableModels: input.ctx.modelRegistry.getAvailable().map(toModelInfo),
        outputBaseDir: resolveSingleRunOutputBaseDir(input.deps, artifactsDir, runId),
        ...(input.absoluteDeadlineAt !== undefined ? { absoluteDeadlineAt: input.absoluteDeadlineAt } : {}),
        capabilityCeiling: resolveCurrentSubagentCapabilityCeiling(currentSessionId),
        runFanoutBudget: createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(input.deps.config.maxSubagentSpawnsPerRun)),
        activeAsyncCapacity,
        externalJobFollowUp: { sourceRunId: input.target.runId, sourceStepIndex: input.target.index, parentProviderJobId: externalJob.providerJobId, requestId, requestDigest },
    }));
    if (result.isError) {
        activeAsyncCapacity?.rollback();
        return result;
    }
    return externalJobFollowUpStarted({ sourceRunId: input.target.runId, runId: result.details.asyncId ?? runId, asyncDir: result.details.asyncDir ?? asyncDir, interactive: input.ctx.hasUI });
}
function resolveRequestedResumeTarget(params, deps, parentSessionFile) {
    const requestedId = params.id ?? params.runId;
    let resolved;
    try {
        resolved = requestedId ? resolveSubagentRunId(requestedId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) })) : undefined;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "";
        const asyncMatches = message.match(/async:/g)?.length ?? 0;
        if (!isResumeAmbiguity(error) || !message.includes("foreground:") || asyncMatches !== 1)
            throw error;
    }
    if (resolved?.kind === "nested") {
        if (params.chain?.length)
            throw new Error("Attaching a running subagent as a chain root is currently available for top-level async runs only.");
        if (resolved.match.run.state === "running" || resolved.match.run.state === "queued")
            return { kind: "live-nested", target: resolved };
        const externalJobTarget = resolveNestedExternalJobResumeTarget(resolved, params, deps);
        if (externalJobTarget)
            return externalJobTarget;
        const trustedSessionRoots = [
            ...(deps.config.defaultSessionDir ? [path.resolve(deps.expandTilde(deps.config.defaultSessionDir))] : []),
            ...(parentSessionFile ? [deps.getSubagentSessionRoot(parentSessionFile)] : []),
        ];
        return resolveNestedResumeTarget(resolved, trustedSessionRoots);
    }
    return resolveResumeTarget(params, deps.state, { asyncRequireSessionFile: false });
}
async function resumeAsyncRun(input) {
    const followUp = (input.params.message ?? input.params.task ?? "").trim();
    const attachChain = (input.params.chain?.length ?? 0) > 0 ? input.params.chain : undefined;
    if (!followUp && !attachChain) {
        return {
            content: [{ type: "text", text: "action='resume' requires message." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const timeoutOverflowError = timerDelayOverflowError("timeoutMs", input.params.timeoutMs);
    if (timeoutOverflowError) {
        return {
            content: [{ type: "text", text: timeoutOverflowError }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (input.params.model !== undefined) {
        return {
            content: [{ type: "text", text: "action='resume' reuses the persisted child model and does not accept a model override." }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const acceptancePolicyErrors = validateExecutionAcceptancePolicy(input.params);
    if (acceptancePolicyErrors.length > 0) {
        return { content: [{ type: "text", text: `Cannot resume: ${acceptancePolicyErrors.join(" ")}` }], isError: true, details: { mode: "management", results: [] } };
    }
    const outputSchemaError = validateLaunchOutputSchemaOverrides(input.params);
    if (outputSchemaError) {
        return { content: [{ type: "text", text: `Cannot resume: ${outputSchemaError}` }], isError: true, details: { mode: "management", results: [] } };
    }
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    let target;
    const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
    try {
        const resolved = resolveRequestedResumeTarget(input.params, input.deps, parentSessionFile);
        if (resolved.kind === "live-nested")
            return resumeLiveNestedRun({ target: resolved.target, message: followUp });
        target = resolved;
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
    }
    if (target.kind === "live" && !attachChain) {
        return {
            content: [{
                    type: "text",
                    text: [
                        `Async child '${target.runId}' index ${target.index} is still running. action='resume' only revives paused, completed, or failed children.`,
                        `Send live input with subagent({ action: "steer", id: "${target.runId}", index: ${target.index}, message: "..." }).`,
                    ].join("\n"),
                }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    const { blocked, depth, maxDepth } = checkSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime);
    if (blocked) {
        return {
            content: [{ type: "text", text: `Nested subagent resume blocked (depth=${depth}, max=${maxDepth}). Complete the follow-up directly instead.` }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    input.deps.state.currentSessionId = resolveCurrentSessionId(input.ctx.sessionManager);
    const effectiveCwd = target.cwd ?? input.requestCwd;
    const scope = resolveExecutionAgentScope(input.params.agentScope);
    const discovered = input.deps.discoverAgents(effectiveCwd, scope, input.parentModel?.provider);
    const discoveredAgents = discovered.agents;
    const unknownAgentDiagnosticContext = diagnosticContextFromDiscovery(discovered, effectiveCwd, scope);
    const modelScope = discovered.modelScope;
    const sessionName = resolveIntercomSessionTarget(input.deps.childRuntime?.intercomSessionName ?? input.deps.pi.getSessionName(), input.ctx.sessionManager.getSessionId());
    const recoveryDescriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
    const recoveryContext = recoveryDescriptor?.context ?? (input.params.context === "profile" ? undefined : input.params.context);
    const intercomBridge = resolveIntercomBridge({
        config: input.deps.config.intercomBridge,
        override: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,
        context: recoveryContext,
        orchestratorTarget: sessionName,
    });
    const agents = intercomBridge.active
        ? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))
        : discoveredAgents;
    const discoveredAgentConfig = discoveredAgents.find((agent) => agent.name === target.agent);
    const baseAgentConfig = discoveredAgentConfig ?? (recoveryDescriptor ? {
        name: recoveryDescriptor.agent,
        description: "Persisted async recovery contract",
        systemPrompt: "",
        systemPromptMode: recoveryDescriptor.systemPromptMode,
        inheritProjectContext: recoveryDescriptor.inheritProjectContext,
        inheritGlobalContext: recoveryDescriptor.inheritGlobalContext,
        inheritSkills: recoveryDescriptor.inheritSkills,
        source: "project",
        filePath: recoveryDescriptor.agentFilePath ?? path.join(getProjectSubagentsDir(recoveryDescriptor.cwd), "recovery-agent"),
        ...(discovered.maxThinking ? { maxThinking: discovered.maxThinking } : {}),
    } : undefined);
    if (!baseAgentConfig) {
        return {
            content: [{ type: "text", text: formatUnknownAgentError(target.agent, unknownAgentDiagnosticContext, "Unknown agent for resume") }],
            isError: true,
            details: { mode: "management", results: [] },
        };
    }
    if (target.source === "async" && target.runner?.type === "external-cli") {
        const runner = normalizeExternalCliRunnerStatus(target.runner);
        const message = runner
            ? `External adapter '${runner.adapter.id}' cannot resume: ${runner.nonResumableReason}`
            : "External runners do not persist Pi sessions and cannot be resumed.";
        return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
    }
    if (target.source === "async" && target.runner?.type === "external-job") {
        if (attachChain)
            return { content: [{ type: "text", text: "External-job follow-up does not support chain attachment. Use action='resume' with message instead." }], isError: true, details: { mode: "management", results: [] } };
        const resumed = await resumeExternalJobFollowUp({
            target,
            followUp,
            baseAgentConfig,
            effectiveCwd,
            requestCwd: input.requestCwd,
            ctx: input.ctx,
            deps: input.deps,
            parentModel: input.parentModel,
            modelScope,
            intercomBridge,
            parentSessionFile,
            absoluteDeadlineAt: input.absoluteDeadlineAt,
        });
        const resumedRunId = resumed.details.runId ?? resumed.details.asyncId;
        if (!resumed.isError && resumedRunId)
            input.onLaunch?.({ agent: target.agent, async: true, runId: resumedRunId });
        return resumed;
    }
    if (attachChain) {
        if (target.source !== "async") {
            return {
                content: [{ type: "text", text: "Attaching a running subagent as a chain root is currently available for async runs only." }],
                isError: true,
                details: { mode: "management", results: [] },
            };
        }
        if (!isAsyncAvailable()) {
            return {
                content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
                isError: true,
                details: { mode: "chain", results: [] },
            };
        }
        const acceptanceErrors = validateExecutionAcceptance(projectEffectiveAcceptanceSchemas(input.params, agents));
        if (acceptanceErrors.length > 0) {
            return { content: [{ type: "text", text: `Cannot resume: ${acceptanceErrors.join(" ")}` }], isError: true, details: { mode: "chain", results: [] } };
        }
        const runId = randomUUID();
        const topLevelResume = depth === 0 && !inheritedNestedRoute(input.deps) && !input.params.workflowParentRunId;
        let activeAsyncCapacity;
        try {
            activeAsyncCapacity = topLevelResume ? acquireActiveAsyncCapacity({
                sessionId: input.deps.state.currentSessionId,
                limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
                runId,
                kind: "runner",
                asyncDir: path.join(DIRS.async, runId),
            }, { liveWorkflowRunIds: new Set(input.deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(input.deps.config.capacity?.abandonedSlotReleaseAfterMs) }) : undefined;
        }
        catch (error) {
            if (error instanceof ActiveAsyncCapacityError)
                return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "chain", results: [], activeAsyncCapacity: error.snapshot } };
            throw error;
        }
        const artifactConfig = omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
        const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
        const contextPolicy = resolveExplicitContextPolicy(input.params);
        const workflowTask = (input.params.task ?? followUp) || undefined;
        const goal = resolveAsyncEventGoal(workflowTask, attachChain);
        const chain = wrapChainTasksForFork(attachChain, contextPolicy);
        const normalized = normalizeSkillInput(input.params.skill);
        const parentModel = input.parentModel;
        const result = executeAsyncChain(runId, compactOptional({
            chain,
            task: workflowTask,
            goal,
            attachRoot: {
                runId: target.runId,
                asyncDir: target.asyncDir ?? path.join(DIRS.async, target.runId),
                resultPath: resolveAsyncRootResultPath(DIRS.results, target.runId),
                index: target.index,
                agent: target.agent,
                label: `Attached ${target.runId}`,
            },
            agents,
            unknownAgentDiagnosticContext,
            ctx: compactOptional({
                pi: input.deps.pi,
                cwd: input.requestCwd,
                currentSessionId: input.deps.state.currentSessionId,
                parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
                currentModelProvider: parentModel?.provider,
                currentModel: parentModel,
                scopedModelIds: scopedModelIdsFromContext(input.ctx),
                modelScope,
                modelResponseAliases: input.deps.config.modelResponseAliases,
                interactive: input.ctx.hasUI,
                permissions: input.deps.config.permissions,
                childRuntime: input.deps.childRuntime,
                projectTrusted: sessionProjectTrust(input.ctx),
            }),
            availableModels,
            cwd: effectiveCwd,
            maxOutput: input.params.maxOutput,
            artifactsDir: getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir),
            artifactConfig,
            shareEnabled: input.params.share === true,
            sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
            chainSkills: normalized === false ? [] : (normalized ?? []),
            agentContract: input.params.agentContract,
            fast: input.params.fast,
            dynamicFanoutMaxItems: input.deps.config.chain?.dynamicFanout?.maxItems,
            maxSubagentDepth: resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime),
            waitToolEnabled: input.deps.waitToolEnabled,
            waitToolDefaultTimeoutMs: input.deps.waitToolDefaultTimeoutMs,
            worktreeSetupHook: input.deps.config.worktreeSetupHook,
            worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
            worktreeBaseDir: input.deps.config.worktreeBaseDir,
            baseRef: input.params.baseRef ?? target.recoveryDescriptor?.baseRef,
            ...(recoveryDescriptor?.requiredExtensions ? { requiredExtensions: recoveryDescriptor.requiredExtensions } : {}),
            worktreeProvider: input.deps.config.worktreeProvider,
            worktreeBranchPrefix: input.deps.config.worktreeBranchPrefix,
            controlConfig: resolveControlConfig(input.deps.config.control, input.params.control),
            controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
            childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
            globalConcurrencyLimit: input.deps.config.globalConcurrencyLimit,
            runFanoutBudget: createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(input.deps.config.maxSubagentSpawnsPerRun)),
            capabilityCeiling: intersectSubagentCapabilityCeilings("capabilityCeiling" in target ? target.capabilityCeiling : undefined, resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
            thinkingCeiling: target.thinkingCeiling,
            activeAsyncCapacity,
        }));
        if (result.isError) {
            activeAsyncCapacity?.rollback();
            return result;
        }
        const attachedId = result.details.asyncId ?? runId;
        input.onLaunch?.({ agent: target.agent, ...(target.sessionFile ? { sessionFile: target.sessionFile } : {}), async: true, runId: attachedId });
        const lines = [
            `Attached async subagent ${target.runId} as the first step of a new chain.`,
            `Chain run: ${attachedId}`,
            `Root: ${target.agent} (step ${target.index + 1})`,
            result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
            `Status if needed: subagent({ action: "status", id: "${attachedId}" })`,
        ].filter((line) => Boolean(line));
        return { content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }], details: result.details };
    }
    const sourceAsyncDir = target.source === "async" ? target.asyncDir : undefined;
    const queuedBriefs = sourceAsyncDir ? readRevivalBriefs(sourceAsyncDir) : [];
    const effectiveFollowUp = [...queuedBriefs.map(({ request }) => request.message), followUp].filter(Boolean).join("\n\n");
    const revivalSessionFile = target.sessionFile;
    if (!revivalSessionFile) {
        return { content: [{ type: "text", text: `Async run '${target.runId}' child ${target.index} does not have a persisted session file to resume from.` }], isError: true, details: { mode: "management", results: [] } };
    }
    if (input.params.baseRef !== undefined && "managedWorktree" in target && target.managedWorktree === true) {
        return { content: [{ type: "text", text: "Cannot resume with baseRef: retained managed-worktree children continue in their existing worktree. Start a new worktree run from that base ref instead." }], isError: true, details: { mode: "management", results: [] } };
    }
    if (target.source === "async" && asyncReviveRequiresRecoveryDescriptor(target)) {
        return { content: [{ type: "text", text: `Async child '${target.runId}' is missing its required run fan-out recovery identity. Start a new run instead.` }], isError: true, details: { mode: "management", results: [] } };
    }
    if (target.source === "nested" && !target.recoveryDescriptor) {
        return { content: [{ type: "text", text: `Nested child '${target.runId}' is missing its required recovery identity. Start a new run instead.` }], isError: true, details: { mode: "management", results: [] } };
    }
    const recoveryAgentConfig = recoveryDescriptor ? applySteeringRecoveryAgentConfig(baseAgentConfig, recoveryDescriptor) : baseAgentConfig;
    const agentConfig = intercomBridge.active ? applyIntercomBridgeToAgent(recoveryAgentConfig, intercomBridge) : recoveryAgentConfig;
    const foregroundContract = target.source === "foreground" ? target.resumeContract : undefined;
    const outputSchema = Object.hasOwn(input.params, "outputSchema")
        ? input.params.outputSchema
        : Object.hasOwn(foregroundContract ?? {}, "outputSchema")
            ? foregroundContract?.outputSchema
            : recoveryDescriptor?.structuredOutputSchema;
    const acceptance = input.params.acceptance !== undefined
        ? input.params.acceptance
        : foregroundContract?.acceptance !== undefined
            ? foregroundContract.acceptance
            : recoveryDescriptor?.acceptance;
    const acceptanceErrors = validateExecutionAcceptance({ ...input.params, acceptance, outputSchema });
    if (acceptanceErrors.length > 0) {
        return { content: [{ type: "text", text: `Cannot resume: ${acceptanceErrors.join(" ")}` }], isError: true, details: { mode: "management", results: [] } };
    }
    const runId = randomUUID();
    const topLevelResume = depth === 0 && !inheritedNestedRoute(input.deps) && !input.params.workflowParentRunId;
    let activeAsyncCapacity;
    try {
        activeAsyncCapacity = !topLevelResume ? undefined : target.source === "async"
            ? transferActiveAsyncCapacity({
                sessionId: input.deps.state.currentSessionId,
                limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
                sourceRunId: target.runId,
                runId,
                asyncDir: path.join(DIRS.async, runId),
            }, { abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(input.deps.config.capacity?.abandonedSlotReleaseAfterMs) })
            : acquireActiveAsyncCapacity({
                sessionId: input.deps.state.currentSessionId,
                limit: resolveMaxActiveAsyncRunsPerSession(input.deps.config.maxActiveAsyncRunsPerSession),
                runId,
                kind: "runner",
                asyncDir: path.join(DIRS.async, runId),
            }, { abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(input.deps.config.capacity?.abandonedSlotReleaseAfterMs) });
    }
    catch (error) {
        if (error instanceof ActiveAsyncCapacityError)
            return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "single", results: [], activeAsyncCapacity: error.snapshot } };
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "single", results: [] } };
    }
    const agentContract = input.params.agentContract ?? foregroundContract?.agentContract ?? recoveryDescriptor?.agentContract;
    const artifactConfig = recoveryDescriptor?.artifactConfig ?? omitUndefinedProperties({ ...DEFAULT_ARTIFACT_CONFIG, enabled: input.params.artifacts !== false, dir: input.deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir });
    const artifactsDir = recoveryDescriptor?.artifactsDir ?? getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
    const availableModels = input.ctx.modelRegistry.getAvailable().map(toModelInfo);
    const parentModel = input.parentModel;
    const revivalAsyncDir = path.join(DIRS.async, runId);
    const result = await executeAsyncSingle(runId, compactOptional({
        agent: target.agent,
        task: buildRevivedAsyncTask(target, effectiveFollowUp),
        goal: effectiveFollowUp,
        agentConfig,
        recoveryAgentConfig,
        ctx: compactOptional({
            pi: input.deps.pi,
            cwd: input.requestCwd,
            currentSessionId: input.deps.state.currentSessionId,
            parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
            currentModelProvider: parentModel?.provider,
            currentModel: parentModel,
            scopedModelIds: scopedModelIdsFromContext(input.ctx),
            modelScope,
            // Absence in the retained contract is meaningful; never acquire current aliases.
            modelResponseAliases: recoveryDescriptor ? recoveryDescriptor.modelResponseAliases : foregroundContract?.modelResponseAliases,
            interactive: input.ctx.hasUI,
            permissions: input.deps.config.permissions,
            childRuntime: input.deps.childRuntime,
            projectTrusted: sessionProjectTrust(input.ctx),
        }),
        cwd: effectiveCwd,
        maxOutput: input.params.maxOutput ?? recoveryDescriptor?.maxOutput,
        artifactsDir,
        artifactConfig,
        shareEnabled: recoveryDescriptor?.share ?? input.params.share === true,
        sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile ?? revivalSessionFile),
        ...(recoveryDescriptor?.sessionDir ? { sessionDir: recoveryDescriptor.sessionDir } : {}),
        sessionFile: revivalSessionFile,
        revivalLease: {
            sessionFile: revivalSessionFile,
            runId,
            sourceRunId: target.runId,
            ...(input.deps.state.currentSessionId ? { parentSessionId: input.deps.state.currentSessionId } : {}),
        },
        context: recoveryContext,
        modelOverride: recoveryDescriptor?.model ?? target.model,
        fast: recoveryDescriptor?.fast,
        modelOverrideFromParent: recoveryDescriptor?.modelOverrideFromParent,
        modelOrigin: recoveryDescriptor?.modelOrigin ?? (recoveryDescriptor?.modelOverrideFromParent ? "inherited" : undefined),
        thinkingOverride: recoveryDescriptor?.thinking ?? target.thinking,
        thinkingCeiling: recoveryDescriptor?.thinkingCeiling ?? ("thinkingCeiling" in target ? target.thinkingCeiling : undefined),
        extensionBindings: recoveryDescriptor?.extensionBindings ?? ("extensionBindings" in target ? target.extensionBindings : undefined),
        requiredExtensions: recoveryDescriptor?.requiredExtensions ?? target.requiredExtensions,
        outputBaseDir: resolveSingleRunOutputBaseDir(input.deps, artifactsDir, runId),
        maxSubagentDepth: recoveryDescriptor?.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(input.deps.config.maxSubagentDepth, input.deps.childRuntime),
        waitToolEnabled: input.deps.waitToolEnabled,
        waitToolDefaultTimeoutMs: input.deps.waitToolDefaultTimeoutMs,
        worktreeSetupHook: input.deps.config.worktreeSetupHook,
        worktreeSetupHookTimeoutMs: input.deps.config.worktreeSetupHookTimeoutMs,
        worktreeBaseDir: input.deps.config.worktreeBaseDir,
        baseRef: input.params.baseRef ?? recoveryDescriptor?.baseRef,
        worktreeProvider: input.deps.config.worktreeProvider,
        worktreeBranchPrefix: input.deps.config.worktreeBranchPrefix,
        // A retained async child already owns the recorded worktree. Resume it in
        // place rather than allocating a second provider worktree around it.
        worktree: input.params.worktree === true && !("managedWorktree" in target && target.managedWorktree === true),
        lane: input.params.lane ?? recoveryDescriptor?.lane,
        controlConfig: resolveRevivalControlConfig({ globalConfig: input.deps.config.control, requestedControl: input.params.control, recoveryControlConfig: recoveryDescriptor?.controlConfig }),
        intercomBridge: input.params.intercomBridge ?? recoveryDescriptor?.intercomBridge,
        controlIntercomTarget: intercomBridge.active ? intercomBridge.orchestratorTarget : undefined,
        childIntercomTarget: intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(runId, agent, index) : undefined,
        availableModels,
        output: input.params.output !== undefined ? input.params.output : foregroundContract?.output ?? recoveryDescriptor?.outputPath,
        outputMode: input.params.outputMode ?? foregroundContract?.outputMode ?? recoveryDescriptor?.outputMode,
        outputClaimPath: input.params.workflowOutputClaimPath,
        ...(agentContract ? { agentContract } : {}),
        ...(outputSchema ? { structuredOutputSchema: outputSchema } : {}),
        ...(recoveryDescriptor?.skills ? { skills: [...recoveryDescriptor.skills] } : {}),
        ...(acceptance !== undefined ? { acceptance } : {}),
        ...(input.params.timeoutMs !== undefined ? { timeoutMs: input.params.timeoutMs } : {}),
        ...(input.absoluteDeadlineAt !== undefined ? { absoluteDeadlineAt: input.absoluteDeadlineAt } : {}),
        ...(input.params.toolBudget !== undefined ? { toolBudget: input.params.toolBudget } : {}),
        // Recovery descriptors, remembered foreground runs, and current workflow roots
        // preserve parent authority before the selected agent's descendant ceiling.
        capabilityCeiling: intersectSubagentCapabilityCeilings(recoveryDescriptor?.capabilityCeiling ?? (target.source === "foreground" || (target.source === "async" && target.mode === "workflow") ? target.capabilityCeiling : undefined), resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId)),
        runFanoutBudget: input.params.runFanoutBudget ?? recoveryDescriptor?.runFanoutBudget ?? createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(input.deps.config.maxSubagentSpawnsPerRun)),
        parentWorkflowRunId: input.params.workflowParentRunId,
        workflowKey: input.params.workflowKey,
        activeAsyncCapacity,
    }));
    const notifyLaunch = () => input.onLaunch?.({ agent: target.agent, sessionFile: revivalSessionFile, async: true, runId });
    if (result.isError) {
        const startedStatus = readStatus(revivalAsyncDir);
        if (input.params.workflowParentRunId !== undefined && startedStatus?.runId === runId && startedStatus.processTerminal?.runnerProcessInstanceId) {
            notifyLaunch();
            return {
                ...result,
                details: {
                    ...result.details,
                    runId,
                    asyncId: runId,
                    asyncDir: revivalAsyncDir,
                    ...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
                },
            };
        }
        activeAsyncCapacity?.rollback();
        return result;
    }
    notifyLaunch();
    for (const brief of queuedBriefs)
        fs.rmSync(brief.path, { force: true });
    if (queuedBriefs.length > 0 && sourceAsyncDir) {
        const sourceStatus = readStatus(sourceAsyncDir);
        if (sourceStatus?.steering) {
            for (const brief of queuedBriefs)
                updateSteeringTarget(sourceStatus.steering, brief.request.id, target.index, "delivered", Date.now());
            createCapacityResilientJsonWriter({ keepAlive: true }).write(path.join(sourceAsyncDir, "status.json"), sourceStatus);
        }
    }
    const revivedId = result.details.asyncId ?? runId;
    if (input.params.workflowParentRunId !== undefined && result.details.asyncDir) {
        const asyncDir = result.details.asyncDir;
        const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
        const stopListener = stopAwaitedAsyncChildOnAbort(input.signal, input.deps.state, revivedId, asyncDir, input.deps.kill);
        const completed = await waitForImportedAsyncRoot({ runId: revivedId, asyncDir, resultPath, index: 0 }, {
            shouldAbort: () => input.signal?.aborted === true,
            timeoutMessage: "Workflow stopped before async child completed.",
            abortedAsStopped: true,
        }).finally(stopListener.remove);
        const details = { ...result.details };
        if (target.launchContractDigest)
            details.sourceLaunchContractDigest = target.launchContractDigest;
        return importWorkflowAwaitedChildResult(completed, { runId: revivedId, asyncDir, resultPath, task: effectiveFollowUp, parentWorkflowRunId: input.params.workflowParentRunId, details, emptyOutputText: `Revived ${target.source} subagent ${revivedId} completed without output.`, state: input.deps.state, pi: input.deps.pi });
    }
    const revivedTarget = intercomBridge.active ? resolveSubagentIntercomTarget(revivedId, target.agent, 0) : undefined;
    const sourceLabel = target.source;
    let workflowRevivalWarning;
    try {
        if (target.source === "async")
            recordWorkflowRevival(DIRS.async, target.runId, revivedId);
    }
    catch (error) {
        workflowRevivalWarning = `Warning: workflow key link not recorded: ${error instanceof Error ? error.message : String(error)}`;
    }
    const lines = [
        `Revived ${sourceLabel} subagent from ${target.runId}.`,
        `Revived run: ${revivedId}`,
        `Agent: ${target.agent}`,
        `Session: ${target.sessionFile}`,
        result.details.asyncDir ? `Async dir: ${result.details.asyncDir}` : undefined,
        workflowRevivalWarning,
        revivedTarget ? `Intercom target: ${revivedTarget} (if registered)` : undefined,
        `Status if needed: subagent({ action: "status", id: "${revivedId}" })`,
    ].filter((line) => Boolean(line));
    return {
        content: [{ type: "text", text: formatAsyncStartedMessage(lines.join("\n"), input.ctx.hasUI) }],
        details: {
            ...result.details,
            ...(target.launchContractDigest ? { sourceLaunchContractDigest: target.launchContractDigest } : {}),
        },
    };
}
function resultSummaryForIntercom(result) {
    const output = getSingleResultOutput(result);
    if (result.exitCode !== 0 && result.error) {
        return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
    }
    return output || result.error || "(no output)";
}
function formatFailedSingleRunOutput(result, displayOutput) {
    const error = result.error || "Failed";
    const output = displayOutput.trim();
    const lines = [error];
    if (output && output !== error.trim()) {
        lines.push("", "Output:", output);
    }
    if (result.artifactPaths?.outputPath && fs.existsSync(result.artifactPaths.outputPath)) {
        lines.push("", `Output artifact: ${result.artifactPaths.outputPath}`);
    }
    return lines.join("\n");
}
function createForegroundControlNotifier(data, deps) {
    return (event) => {
        applyControlEventToRememberedForegroundRun(deps.state, event);
        const eventBridge = intercomBridgeAppliesToAgent(data.intercomBridge, data.contextPolicy, event.agent)
            ? data.intercomBridge
            : { ...data.intercomBridge, active: false };
        const parentWorkflowRunId = data.params.workflowParentRunId;
        const asyncWorkflow = typeof parentWorkflowRunId === "string" ? deps.state.asyncJobs.get(parentWorkflowRunId) : undefined;
        const workflowKey = typeof data.params.workflowKey === "string" && data.params.workflowKey.trim()
            ? data.params.workflowKey.trim()
            : undefined;
        const enriched = workflowKey && !event.workflowKey ? { ...event, workflowKey } : event;
        if (asyncWorkflow) {
            persistAsyncWorkflowControlEvent({
                job: asyncWorkflow,
                event: enriched,
                controlConfig: data.controlConfig,
                intercomBridge: eventBridge,
                childIntercomTarget: eventBridge.active
                    ? resolveSubagentIntercomTarget(enriched.runId, enriched.agent, enriched.index)
                    : undefined,
            });
        }
        emitControlNotification({
            pi: deps.pi,
            controlConfig: data.controlConfig,
            intercomBridge: eventBridge,
            event: enriched,
            source: asyncWorkflow ? "async" : "foreground",
        });
    };
}
export function foregroundResultIntercomStatus(result) {
    return resolveSubagentResultStatus(omitUndefinedProperties({
        exitCode: result.exitCode,
        ...(result.acceptance?.status === "rejected" ? { success: false } : {}),
        interrupted: result.interrupted,
        detached: result.detached,
        processSignal: result.processSignal,
        timedOut: result.timedOut,
        stopped: result.stopped,
        turnBudgetExceeded: result.turnBudgetExceeded,
    }));
}
export function shouldSuppressRoutineResultIntercom(input) {
    return input.suppressRoutineResultIntercom === true
        && input.results.length > 0
        && input.results.every((result) => foregroundResultIntercomStatus(result) === "completed");
}
async function emitForegroundResultIntercom(input) {
    if (!input.intercomBridge.active || !input.intercomBridge.resultDelivery || !input.intercomBridge.orchestratorTarget)
        return null;
    const children = input.results.flatMap((result, index) => result.detached ? [] : [omitUndefinedProperties({
            agent: result.agent,
            ...(result.sessionName ? { sessionName: result.sessionName } : {}),
            status: foregroundResultIntercomStatus(result),
            outputState: result.outputState ?? "unknown",
            summary: resultSummaryForIntercom(result),
            index,
            artifactPath: result.artifactPaths?.outputPath,
            sessionPath: result.sessionFile,
            intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
        })]);
    if (children.length === 0)
        return null;
    const payload = buildSubagentResultIntercomPayload({
        to: input.intercomBridge.orchestratorTarget,
        runId: input.runId,
        mode: input.mode,
        source: "foreground",
        children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
        ...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
        ...(input.parallelHandoff ? { parallelHandoff: input.parallelHandoff } : {}),
    });
    const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
    if (!delivered)
        return null;
    return payload;
}
async function maybeBuildForegroundIntercomReceipt(input) {
    const payload = await emitForegroundResultIntercom({
        pi: input.pi,
        intercomBridge: input.intercomBridge,
        runId: input.runId,
        mode: input.mode,
        results: input.details.results,
        ...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
        ...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
        ...(input.details.parallelHandoff ? { parallelHandoff: input.details.parallelHandoff } : {}),
    });
    if (!payload)
        return null;
    return {
        text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
        details: input.preserveDetailsOutputs ? input.details : stripDetailsOutputsForIntercomReceipt(input.details),
    };
}
function diagnosticContextFromDiscovery(discovered, cwd, scope) {
    if (discovered.cwd && discovered.scope && discovered.directories)
        return unknownAgentDiagnosticContext({ ...discovered, cwd: discovered.cwd, scope: discovered.scope, directories: discovered.directories });
    return unknownAgentDiagnosticContext(discoverAgents(path.resolve(cwd), scope));
}
function canonicalizeAgentName(name, agents, diagnostics, context) {
    const resolved = resolveAgentName(name, agents);
    const candidates = resolved.error ? agents.filter((agent) => resolveAgentName(name, [agent]).agent) : resolved.agent;
    const diagnostic = findBlockingAgentDiagnostic(name, candidates, diagnostics);
    if (diagnostic)
        return { error: `Agent '${name}' has invalid configuration: ${diagnostic.error}` };
    if (resolved.error)
        return { error: resolved.error };
    if (!resolved.agent)
        return { error: formatUnknownAgentError(name, context) };
    return { name: resolved.agent.name };
}
// Mirrors child launch: workflow children without their own cwd/agentScope discover agents at the workflow cwd and scope.
function workflowValidationOptions(deps, params, runtimeCwd, parentModelProvider) {
    const cwd = resolveRequestedCwd(runtimeCwd, params.cwd);
    const scope = resolveExecutionAgentScope(params.agentScope);
    let discovered;
    return {
        maxSubagentSpawnsPerRun: params.maxSubagentSpawnsPerRun ?? resolveMaxSubagentSpawnsPerRun(deps.config.maxSubagentSpawnsPerRun),
        agentNameError: (name) => {
            discovered ??= deps.discoverAgents(cwd, scope, parentModelProvider());
            const { agents } = discovered;
            const resolved = resolveAgentName(name, agents);
            if (resolved.agent || resolved.error)
                return canonicalizeAgentName(name, agents, discovered.agentDiagnostics, diagnosticContextFromDiscovery(discovered, cwd, scope)).error;
            const requested = name.trim().toLowerCase();
            const suggestion = [...new Set(agents.flatMap((agent) => [agent.name, ...(agent.localName ? [agent.localName] : []), ...(agent.aliases ?? [])]))]
                .map((candidate) => ({ candidate, distance: editDistance(requested, candidate.toLowerCase()) }))
                .filter(({ candidate, distance }) => distance <= Math.max(1, Math.floor(candidate.length / 4)) || hasSingleAdjacentTransposition(requested, candidate.toLowerCase()))
                .sort((left, right) => left.distance - right.distance || left.candidate.localeCompare(right.candidate))[0]?.candidate;
            return `Unknown agent '${name}'.${suggestion ? ` Did you mean '${suggestion}'?` : ""} Use subagent({ action: "list" }) to inspect agents.`;
        },
    };
}
function canonicalizeExecutionParams(params, agents, diagnostics, context) {
    const resolve = (name, location) => {
        const result = canonicalizeAgentName(name, agents, diagnostics, context);
        return result.error && location ? { error: `${result.error} (${location})` } : result;
    };
    if (params.agent) {
        const result = resolve(params.agent);
        if (result.error)
            return { error: result.error };
        params = omitUndefinedProperties({ ...params, agent: result.name });
        const agent = agents.find((candidate) => candidate.name === result.name);
        if (params.extensionBindings !== undefined && (agent?.runner?.type === "external-cli" || agent?.runner?.type === "external-job"))
            return { error: `extensionBindings is not supported for runner.type='${agent.runner.type}'.` };
        const machineError = agent ? formatHerdrMachineRunnerUnsupported({ machine: params.machine ?? agent.machine, agentName: agent.name, runnerType: agent.runner?.type, adapter: agent.runner?.type === "external-cli" ? agent.runner.adapter : undefined, worktree: params.worktree }) : undefined;
        if (machineError)
            return { error: machineError };
    }
    if (params.extensionBindings !== undefined) {
        try {
            params = { ...params, extensionBindings: normalizeExtensionBindings(params.extensionBindings).value };
        }
        catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }
    if (params.tasks) {
        const tasks = [];
        for (let index = 0; index < params.tasks.length; index++) {
            const task = params.tasks[index];
            const result = resolve(task.agent, `task ${index + 1}`);
            if (result.error)
                return { error: result.error };
            tasks.push({ ...task, agent: result.name });
        }
        params = { ...params, tasks };
    }
    if (params.chain) {
        const chain = [];
        for (let index = 0; index < params.chain.length; index++) {
            const step = params.chain[index];
            if (isParallelStep(step)) {
                const parallel = [];
                for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
                    const task = step.parallel[taskIndex];
                    const result = resolve(task.agent, `step ${index + 1}, task ${taskIndex + 1}`);
                    if (result.error)
                        return { error: result.error };
                    parallel.push({ ...task, agent: result.name });
                }
                chain.push({ ...step, parallel });
                continue;
            }
            if (isDynamicParallelStep(step)) {
                const result = resolve(step.parallel.agent, `step ${index + 1}`);
                if (result.error)
                    return { error: result.error };
                chain.push({ ...step, parallel: { ...step.parallel, agent: result.name } });
                continue;
            }
            if ("agent" in step && typeof step.agent === "string") {
                const result = resolve(step.agent, `step ${index + 1}`);
                if (result.error)
                    return { error: result.error };
                chain.push({ ...step, agent: result.name });
                continue;
            }
            chain.push(step);
        }
        params = { ...params, chain };
    }
    return { params };
}
function projectEffectiveAcceptanceSchemas(params, agents) {
    const withEffectiveSchema = (step) => {
        const agent = agents.find((candidate) => candidate.name === step.agent);
        return agent ? { ...step, outputSchema: resolveEffectiveOutputSchema(agent, step.outputSchema) } : step;
    };
    return {
        ...params,
        ...(params.tasks ? { tasks: params.tasks.map(withEffectiveSchema) } : {}),
        ...(params.chain ? { chain: projectChainOutputSchemas(params.chain, agents) } : {}),
    };
}
function validateExecutionInput(params, agents, hasChain, hasTasks, hasSingle, allowClarifyTaskPrompt, context) {
    if (Number(hasChain) + Number(hasTasks) + Number(hasSingle) !== 1) {
        const agentList = agents.map((a) => a.name).join(", ") || "none";
        const noMode = !hasChain && !hasTasks && !hasSingle;
        return {
            content: [
                {
                    type: "text",
                    text: noMode && typeof params.workflowKey === "string"
                        ? `Workflow child '${params.workflowKey}' has no agent. Pass { key, agent, task }. Agents: ${agentList}`
                        : `Provide exactly one mode. Agents: ${agentList}`,
                },
            ],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const acceptanceErrors = validateExecutionAcceptance(projectEffectiveAcceptanceSchemas(params, agents));
    if (acceptanceErrors.length > 0) {
        return {
            content: [{ type: "text", text: acceptanceErrors.join(" ") }],
            isError: true,
            details: { mode: getRequestedModeLabel(params), results: [] },
        };
    }
    if (hasSingle && params.agent && !agents.find((agent) => agent.name === params.agent)) {
        return {
            content: [{ type: "text", text: formatUnknownAgentError(params.agent, context) }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    if (hasTasks && params.tasks) {
        for (let i = 0; i < params.tasks.length; i++) {
            const task = params.tasks[i];
            if (!agents.find((agent) => agent.name === task.agent)) {
                return {
                    content: [{ type: "text", text: `${formatUnknownAgentError(task.agent, context)} (task ${i + 1})` }],
                    isError: true,
                    details: { mode: "parallel", results: [] },
                };
            }
        }
    }
    if (hasChain && params.chain) {
        if (params.chain.length === 0) {
            return {
                content: [{ type: "text", text: "Chain must have at least one step" }],
                isError: true,
                details: { mode: "chain", results: [] },
            };
        }
        const firstStep = params.chain[0];
        if (isParallelStep(firstStep)) {
            const missingTaskIndex = firstStep.parallel.findIndex((t) => !t.task);
            if (missingTaskIndex !== -1) {
                return {
                    content: [{ type: "text", text: `First parallel step: task ${missingTaskIndex + 1} must have a task (no previous output to reference)` }],
                    isError: true,
                    details: { mode: "chain", results: [] },
                };
            }
        }
        else if (isDynamicParallelStep(firstStep)) {
            return {
                content: [{ type: "text", text: "First step in chain cannot be dynamic fanout; expand.from requires a prior structured named output" }],
                isError: true,
                details: { mode: "chain", results: [] },
            };
        }
        else if (!firstStep.task && !params.task && !allowClarifyTaskPrompt) {
            return {
                content: [{ type: "text", text: "First step in chain must have a task" }],
                isError: true,
                details: { mode: "chain", results: [] },
            };
        }
        for (let i = 0; i < params.chain.length; i++) {
            const step = params.chain[i];
            const stepAgents = getStepAgents(step);
            for (const agentName of stepAgents) {
                if (!agents.find((a) => a.name === agentName)) {
                    return {
                        content: [{ type: "text", text: `${formatUnknownAgentError(agentName, context)} (step ${i + 1})` }],
                        isError: true,
                        details: { mode: "chain", results: [] },
                    };
                }
            }
            if (isParallelStep(step) && step.parallel.length === 0) {
                return {
                    content: [{ type: "text", text: `Parallel step ${i + 1} must have at least one task` }],
                    isError: true,
                    details: { mode: "chain", results: [] },
                };
            }
        }
    }
    return null;
}
function validateExecutionChainBindings(params, dynamicFanoutMaxItems) {
    if ((params.chain?.length ?? 0) === 0)
        return null;
    try {
        validateChainOutputBindingsWithContext(params.chain, dynamicFanoutMaxItems === undefined ? {} : { maxItems: dynamicFanoutMaxItems });
    }
    catch (error) {
        if (error instanceof ChainOutputValidationError) {
            return {
                content: [{ type: "text", text: error.message }],
                isError: true,
                details: { mode: "chain", results: [] },
            };
        }
        throw error;
    }
    return null;
}
function getRequestedModeLabel(params) {
    if (params.workflowScript !== undefined)
        return "workflow";
    if ((params.chain?.length ?? 0) > 0)
        return "chain";
    if ((params.tasks?.length ?? 0) > 0)
        return "parallel";
    if (params.agent)
        return "single";
    return "single";
}
function formatStatusTargetLabel(params, targetRunId) {
    let target;
    if (targetRunId) {
        target = `run ${targetRunId}`;
    }
    else if (params.dir) {
        target = `dir ${params.dir}`;
    }
    else {
        target = params.view === "transcript" ? "active run" : "active runs";
    }
    if (params.view !== "transcript")
        return `Status target: ${target}`;
    return `Transcript target: ${target}${params.index !== undefined ? ` · child ${params.index}` : ""}`;
}
function resolveAgentDefaultContextPolicy(params, agents, defaultSubagentContext, canUseDefaultFork = false) {
    if (params.context === "profile") {
        const byName = new Map(agents.map((agent) => [agent.name, agent]));
        for (const agentName of collectRequestedAgentNames(params)) {
            const agent = byName.get(agentName);
            if (agent && agent.defaultContext === undefined) {
                return { error: `context: "profile" requires agent '${agentName}' to declare defaultContext.` };
            }
        }
        const contextForAgent = (agentName) => {
            const context = byName.get(agentName)?.defaultContext;
            if (context === undefined)
                throw new Error(`context: "profile" requires agent '${agentName}' to declare defaultContext.`);
            return context;
        };
        const contextSummary = summarizeContextModes(collectRequestedAgentNames(params).map(contextForAgent));
        return {
            params,
            contextForAgent,
            contextSummary,
            usesFork: contextSummary === "fork" || contextSummary === "mixed",
        };
    }
    if (params.context === "fresh" || params.context === "fork")
        return resolveExplicitContextPolicy(params);
    const byName = new Map(agents.map((agent) => [agent.name, agent]));
    const contextForAgent = (agentName) => resolveSubagentLaunchContext({
        explicitContext: undefined,
        agentDefaultContext: byName.get(agentName)?.defaultContext,
        defaultSubagentContext,
        canUseImplicitFork: canUseDefaultFork,
    });
    const requestedAgentNames = collectRequestedAgentNames(params);
    const contextSummary = summarizeContextModes(requestedAgentNames.map((name) => contextForAgent(name)));
    const usesFork = contextSummary === "fork" || contextSummary === "mixed";
    return omitUndefinedProperties({
        params,
        contextForAgent,
        contextSummary,
        usesFork,
    });
}
function resolveExplicitContextPolicy(params) {
    const context = resolveSubagentLaunchContext({
        explicitContext: params.context === "profile" ? undefined : params.context,
        canUseImplicitFork: false,
    });
    return {
        params,
        contextForAgent: () => context,
        contextSummary: context,
        usesFork: context === "fork",
    };
}
function collectRequestedAgentNames(params) {
    const names = [];
    if (params.agent)
        names.push(params.agent);
    for (const task of params.tasks ?? [])
        names.push(task.agent);
    for (const step of params.chain ?? [])
        names.push(...getStepAgents(step));
    return names;
}
function shouldForkAgent(contextPolicy, agentName) {
    return contextPolicy.contextForAgent(agentName) === "fork";
}
function intercomBridgeAppliesToAgent(bridge, contextPolicy, agentName) {
    if (!bridge.active)
        return false;
    return bridge.mode !== "fork-only" || shouldForkAgent(contextPolicy, agentName);
}
function applyScopedIntercomBridgeToAgents(agents, bridge, contextPolicy) {
    if (!bridge.active)
        return agents;
    return agents.map((agent) => intercomBridgeAppliesToAgent(bridge, contextPolicy, agent.name)
        ? applyIntercomBridgeToAgent(agent, bridge)
        : agent);
}
function resolveChildIntercomTargetFactory(bridge, contextPolicy, runId) {
    if (!bridge.active)
        return undefined;
    return (agent, index) => intercomBridgeAppliesToAgent(bridge, contextPolicy, agent)
        ? resolveSubagentIntercomTarget(runId, agent, index)
        : undefined;
}
function resolveRunLevelIntercomTarget(bridge, contextPolicy) {
    if (!bridge.active)
        return undefined;
    if (bridge.mode === "fork-only" && contextPolicy.contextSummary === "mixed")
        return undefined;
    return bridge.orchestratorTarget;
}
function summarizeResultContext(details, fallback) {
    return summarizeContextModes(details.results.map((result) => result.context)) ?? fallback;
}
function buildRequestedModeError(params, message) {
    return withResolvedContext({
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    }, params.context === "profile" ? undefined : params.context);
}
function buildWorkflowValidationResult(validation, mode, preflight) {
    const payload = preflight ? { ...validation, preflight } : validation;
    return {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        ...(validation.ok ? {} : { isError: true }),
        details: { mode, results: [] },
    };
}
function applySingleAgentLaunchDefaults(params, agents) {
    if ((params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0 || !params.agent)
        return params;
    const agent = agents.find((candidate) => candidate.name === params.agent);
    if (!agent)
        return params;
    const parentTimeoutMs = params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs === undefined && params.workflowParentDeadlineAt !== undefined
        ? Math.max(1, params.workflowParentDeadlineAt - Date.now())
        : undefined;
    const outputSchema = params.outputSchema === false ? false : resolveEffectiveOutputSchema(agent, params.outputSchema);
    return {
        ...params,
        ...(params.async === undefined && agent.defaultAsync !== undefined ? { async: agent.defaultAsync } : {}),
        ...(params.timeoutMs === undefined && params.maxRuntimeMs === undefined && agent.defaultTimeoutMs !== undefined
            ? { timeoutMs: agent.defaultTimeoutMs }
            : {}),
        ...(parentTimeoutMs !== undefined ? { timeoutMs: parentTimeoutMs } : {}),
        ...(params.acceptance === undefined && agent.defaultAcceptance !== undefined
            ? { acceptance: agent.defaultAcceptance }
            : {}),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
    };
}
function validateLaunchOutputSchemaOverrides(params) {
    const values = [params.outputSchema, ...(params.tasks ?? []).map((task) => task.outputSchema)];
    for (const step of params.chain ?? []) {
        if (isParallelStep(step))
            values.push(...step.parallel.map((task) => task.outputSchema));
        else if (isDynamicParallelStep(step))
            values.push(step.parallel.outputSchema);
        else
            values.push(step.outputSchema);
    }
    for (const value of values) {
        if (value === undefined || value === false)
            continue;
        try {
            assertJsonSchemaObject(value, "outputSchema");
        }
        catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }
    return undefined;
}
export const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60 * 1000;
// Async single-agent runs also need a wall-clock backstop: a child whose bash
// tool blocks forever (e.g. a background process inheriting the terminal with
// no bash `timeout` arg) would otherwise hang the parent indefinitely with
// zero signal. Same generous default as foreground; explicit timeoutMs/
// maxRuntimeMs and agent-level defaultTimeoutMs remain authoritative.
//
// Deliberately NOT applied at the workflow level: async scripted workflows
// stay unbounded as a whole, while each runner child has its own deadline.
export { DEFAULT_ASYNC_TIMEOUT_MS };
/**
 * Maximum delay a Node.js timer accepts. Values above the 32-bit signed integer
 * ceiling overflow `setTimeout`, which silently clamps the delay to ~1ms and
 * fires almost immediately — so a run configured with a larger deadline would
 * terminate right away while reporting the long duration. Any timeout destined
 * for a timer must stay within this bound.
 */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
function timerDelayOverflowError(name, value) {
    return typeof value === "number" && value > MAX_TIMER_DELAY_MS
        ? `${name} must be a positive integer no larger than ${MAX_TIMER_DELAY_MS}.`
        : undefined;
}
/**
 * Resolve the optional global default runtime deadline from extension config
 * (`config.timeoutMs`). Returns undefined for unset or invalid values so callers
 * fall back to the built-in defaults. "Invalid" covers non-positive-integer
 * values and values above `MAX_TIMER_DELAY_MS`; the latter would overflow the
 * Node.js timer and expire the run almost immediately instead of running long.
 */
export function resolveConfigDefaultTimeoutMs(raw) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0 || raw > MAX_TIMER_DELAY_MS)
        return undefined;
    return raw;
}
export function resolveForegroundTimeout(params, defaultTimeoutMs) {
    const rawTimeout = params.timeoutMs;
    const rawMaxRuntime = params.maxRuntimeMs;
    if (rawTimeout === undefined && rawMaxRuntime === undefined) {
        return defaultTimeoutMs === undefined ? {} : { timeoutMs: defaultTimeoutMs };
    }
    for (const [name, value] of [["timeoutMs", rawTimeout], ["maxRuntimeMs", rawMaxRuntime]]) {
        if (value === undefined)
            continue;
        if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
            return { error: `${name} must be a positive integer.` };
        }
        const overflowError = timerDelayOverflowError(name, value);
        if (overflowError)
            return { error: overflowError };
    }
    if (rawTimeout !== undefined && rawMaxRuntime !== undefined && rawTimeout !== rawMaxRuntime) {
        return { error: "timeoutMs and maxRuntimeMs are aliases; provide only one value or use the same value for both." };
    }
    const timeoutMs = rawTimeout ?? rawMaxRuntime;
    return timeoutMs === undefined ? {} : { timeoutMs };
}
/**
 * Resolve the effective launch timeout for a single-agent run, applying the
 * async/foreground default when neither the caller nor the agent set one.
 *
 * A global config default (`config.timeoutMs`, passed as `configDefaultTimeoutMs`)
 * replaces the built-in 30-minute backstop wherever a concrete default is applied.
 * The async default is deliberately applied only to plain single-agent launches.
 * Composite launches keep their top-level execution unbounded when no timeout is
 * set — even with a config default — while their runner children resolve separate
 * deadlines. Exported so the executor wiring is directly testable.
 */
export function resolveSingleAgentLaunchTimeout(params, async, configDefaultTimeoutMs) {
    const isComposite = (params.chain?.length ?? 0) > 0 || (params.tasks?.length ?? 0) > 0 || params.workflowScript !== undefined;
    const foregroundDefault = configDefaultTimeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS;
    const asyncSingleDefault = configDefaultTimeoutMs ?? DEFAULT_ASYNC_TIMEOUT_MS;
    const defaultTimeoutMs = !async ? foregroundDefault : isComposite ? undefined : asyncSingleDefault;
    return resolveForegroundTimeout(params, defaultTimeoutMs);
}
function resolveToolBudget(raw, label = "toolBudget", options) {
    const resolved = validateToolBudgetConfig(raw, label, options);
    return { ...(resolved.budget === undefined ? {} : { toolBudget: resolved.budget }), ...(resolved.error === undefined ? {} : { error: resolved.error }) };
}
function resolveEffectiveToolBudget(input) {
    if (input.stepBudget !== undefined)
        return resolveToolBudget(input.stepBudget, "toolBudget");
    if (input.runBudget !== undefined)
        return { toolBudget: input.runBudget };
    if (input.agentBudget !== undefined)
        return resolveToolBudget(input.agentBudget, "agent.toolBudget");
    return resolveToolBudget(input.configBudget, "config.toolBudget");
}
function expandTopLevelTaskCounts(tasks) {
    const expanded = [];
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex++) {
        const task = tasks[taskIndex];
        const rawCount = task.count;
        if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
            return { error: `tasks[${taskIndex}].count must be an integer >= 1` };
        }
        const { count, ...concreteTask } = task;
        for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
            expanded.push({ ...concreteTask });
        }
    }
    return { tasks: expanded };
}
function expandChainParallelCounts(chain) {
    const expandedChain = [];
    for (let stepIndex = 0; stepIndex < chain.length; stepIndex++) {
        const step = chain[stepIndex];
        if (!isParallelStep(step)) {
            expandedChain.push(step);
            continue;
        }
        const expandedParallel = [];
        for (let taskIndex = 0; taskIndex < step.parallel.length; taskIndex++) {
            const task = step.parallel[taskIndex];
            const rawCount = task.count;
            if (rawCount !== undefined && (typeof rawCount !== "number" || !Number.isInteger(rawCount) || rawCount < 1)) {
                return { error: `chain[${stepIndex}].parallel[${taskIndex}].count must be an integer >= 1` };
            }
            const { count, ...concreteTask } = task;
            for (let repeat = 0; repeat < (rawCount ?? 1); repeat++) {
                expandedParallel.push({ ...concreteTask });
            }
        }
        expandedChain.push({ ...step, parallel: expandedParallel });
    }
    return { chain: expandedChain };
}
function normalizeRepeatedParallelCounts(params) {
    if (params.tasks) {
        const expandedTasks = expandTopLevelTaskCounts(params.tasks);
        if (expandedTasks.error) {
            return { error: buildRequestedModeError(params, expandedTasks.error) };
        }
        return { params: { ...params, ...(expandedTasks.tasks === undefined ? {} : { tasks: expandedTasks.tasks }) } };
    }
    if (params.chain) {
        const expandedChain = expandChainParallelCounts(params.chain);
        if (expandedChain.error) {
            return { error: buildRequestedModeError(params, expandedChain.error) };
        }
        return { params: { ...params, ...(expandedChain.chain === undefined ? {} : { chain: expandedChain.chain }) } };
    }
    return { params };
}
function withResolvedContext(result, fallback) {
    if (!result.details)
        return result;
    const context = summarizeResultContext(result.details, fallback);
    if (!context)
        return result;
    return {
        ...result,
        details: {
            ...result.details,
            context,
        },
    };
}
function withAggregatedToolUsage(result) {
    const highWarnings = result.details.results.flatMap((child) => child.watchdog?.warnings?.filter((warning) => warning.importance === "high") ?? []);
    const projected = {
        ...result,
        ...(highWarnings.length ? { content: [...result.content, { type: "text", text: ["High-importance watchdog findings:", ...highWarnings.map((warning) => `- ${warning.severity}: ${warning.summary}\n  Evidence: ${warning.evidence}\n  Recommended action: ${warning.recommendedAction}`)].join("\n") }] } : {}),
        details: {
            ...result.details,
            results: result.details.results.map((child) => ({ ...child, ...(child.watchdog ? { watchdog: childWatchdogProgressForModel(child.watchdog) } : {}) })),
        },
    };
    if (projected.details.results.length === 0)
        return projected;
    const usage = sumResultsUsage(projected.details.results);
    return usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0
        ? { ...projected, usage: toAgentToolUsage(usage) }
        : projected;
}
function toExecutionErrorResult(params, error, contextSummary) {
    const message = error instanceof Error ? error.message : String(error);
    return withResolvedContext({
        content: [{ type: "text", text: message }],
        isError: true,
        details: { mode: getRequestedModeLabel(params), results: [] },
    }, contextSummary);
}
function resolveStaticLaunchSummary(input) {
    const agentConfig = input.agents.find((agent) => agent.name === input.agent);
    const externalRunner = agentConfig?.runner?.type === "external-cli" || agentConfig?.runner?.type === "external-job";
    const modelScopes = resolveModelScopesForAgent(input.modelScope, input.agent, input.parentModel, input.scopedModelIds);
    const model = externalRunner
        ? undefined
        : resolveEffectiveSubagentModel(input.explicitModel, agentConfig?.model, input.parentModel, input.availableModels, agentConfig?.modelProvider ?? input.currentProvider, modelScopes.length === 0 ? {} : { scope: modelScopes });
    const thinkingOverride = externalRunner ? undefined : input.thinkingOverrideForTask();
    const thinking = externalRunner ? undefined : resolveEffectiveThinking(model, thinkingOverride ?? agentConfig?.thinking);
    return {
        agent: input.agent,
        ...(model ? { model } : {}),
        ...(thinking ? { thinking } : {}),
    };
}
function collectStaticLaunchSummaries(input) {
    const summary = (agent, index, explicitModel) => resolveStaticLaunchSummary({
        agent,
        index,
        explicitModel,
        agents: input.agents,
        parentModel: input.parentModel,
        scopedModelIds: input.scopedModelIds,
        availableModels: input.availableModels,
        currentProvider: input.currentProvider,
        modelScope: input.modelScope,
        thinkingOverrideForTask: input.thinkingOverrideForTask,
    });
    if (input.params.tasks)
        return input.params.tasks.map((task, index) => summary(task.agent, index, task.model));
    if (input.params.chain?.length) {
        const launches = [];
        let flatIndex = 0;
        for (const step of input.params.chain) {
            if (isParallelStep(step)) {
                for (const task of step.parallel) {
                    launches.push(summary(task.agent, flatIndex, task.model));
                    flatIndex++;
                }
                continue;
            }
            if (isDynamicParallelStep(step)) {
                const maxItems = step.expand.maxItems ?? input.dynamicFanoutMaxItems ?? 0;
                for (let itemIndex = 0; itemIndex < maxItems; itemIndex++) {
                    launches.push(summary(step.parallel.agent, flatIndex, step.parallel.model));
                    flatIndex++;
                }
                continue;
            }
            const sequential = step;
            launches.push(summary(sequential.agent, flatIndex, sequential.model));
            flatIndex++;
        }
        return launches;
    }
    return input.params.agent ? [summary(input.params.agent, 0, input.params.model)] : [];
}
function firstRawChainTask(chain) {
    const first = chain[0];
    if (!first)
        return undefined;
    if (isParallelStep(first))
        return first.parallel[0]?.task;
    if (isDynamicParallelStep(first))
        return first.parallel.task;
    return first.task;
}
function resolveAsyncEventGoal(workflowTask, rawChain, unwrapForkFallback = false) {
    if (workflowTask?.trim())
        return workflowTask;
    const fallback = firstRawChainTask(rawChain) || "";
    if (!unwrapForkFallback)
        return fallback;
    const forkPrefix = `${DEFAULT_FORK_PREAMBLE}\n\nTask:\n`;
    return fallback.startsWith(forkPrefix) ? fallback.slice(forkPrefix.length) : fallback;
}
function wrapChainTasksForFork(chain, contextPolicy) {
    return chain.map((step, stepIndex) => {
        if (isParallelStep(step)) {
            return compactOptional({
                ...step,
                parallel: step.parallel.map((task) => compactOptional({
                    ...task,
                    task: shouldForkAgent(contextPolicy, task.agent)
                        ? wrapForkTask(task.task ?? "{previous}")
                        : task.task,
                })),
            });
        }
        if (isDynamicParallelStep(step)) {
            return compactOptional({
                ...step,
                parallel: compactOptional({
                    ...step.parallel,
                    task: shouldForkAgent(contextPolicy, step.parallel.agent)
                        ? wrapForkTask(step.parallel.task ?? "{previous}")
                        : step.parallel.task,
                }),
            });
        }
        const sequential = step;
        return compactOptional({
            ...sequential,
            task: shouldForkAgent(contextPolicy, sequential.agent)
                ? wrapForkTask(sequential.task ?? (stepIndex === 0 ? "{task}" : "{previous}"))
                : sequential.task,
        });
    });
}
async function preflightForkSessionsForStaticTasks(params, contextPolicy, prepareSessionForTask, dynamicFanoutMaxItems) {
    if (!contextPolicy.usesFork)
        return;
    if (params.agent) {
        if (shouldForkAgent(contextPolicy, params.agent)) {
            await prepareSessionForTask(params.agent, 0, params.model, params.modelOrigin === "inherited", params.modelOrigin);
        }
        return;
    }
    if (params.tasks) {
        for (const [index, task] of params.tasks.entries()) {
            if (shouldForkAgent(contextPolicy, task.agent))
                await prepareSessionForTask(task.agent, index, task.model);
        }
        return;
    }
    if (!params.chain?.length)
        return;
    let flatIndex = 0;
    for (const step of params.chain) {
        if (isParallelStep(step)) {
            for (const task of step.parallel) {
                if (shouldForkAgent(contextPolicy, task.agent))
                    await prepareSessionForTask(task.agent, flatIndex, task.model);
                flatIndex++;
            }
            continue;
        }
        if (isDynamicParallelStep(step)) {
            const maxItems = step.expand.maxItems ?? dynamicFanoutMaxItems ?? 0;
            if (shouldForkAgent(contextPolicy, step.parallel.agent)) {
                for (let itemIndex = 0; itemIndex < maxItems; itemIndex++)
                    await prepareSessionForTask(step.parallel.agent, flatIndex + itemIndex, step.parallel.model);
            }
            flatIndex += maxItems;
            continue;
        }
        const sequential = step;
        if (shouldForkAgent(contextPolicy, sequential.agent))
            await prepareSessionForTask(sequential.agent, flatIndex, sequential.model);
        flatIndex++;
    }
}
function importedAsyncRootUsage(completed) {
    const totalCost = completed.totalCost;
    return completed.usage ?? {
        input: totalCost?.inputTokens ?? 0,
        output: totalCost?.outputTokens ?? 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: totalCost?.costUsd ?? 0,
        turns: 0,
    };
}
function removeWorkflowAwaitedResult(asyncDir, resultPath, runId, publication) {
    try {
        fs.rmSync(resultPath, { force: true });
    }
    catch {
        // Payload cleanup must not replace an already imported delivery.
    }
    removeResultIndex(asyncDir, publication.sessionId, runId, publication.toolCallId);
}
function emitWorkflowAwaitedChildComplete(pi, state, runId, asyncDir, parentWorkflowRunId, completed) {
    let status;
    try {
        status = readStatus(asyncDir);
    }
    catch (error) {
        console.error(`Failed to read awaited workflow child status for ${runId}; emitting completion with fallback metadata:`, error);
    }
    pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
        id: runId,
        runId,
        sessionId: status?.sessionId ?? completed.importedPublication?.sessionId ?? state.currentSessionId,
        completionOwnerId: status?.completionOwnerId ?? state.completionOwnerId ?? currentCompletionOwnerId(),
        asyncDir,
        agent: completed.agent,
        mode: "single",
        state: completed.stopped ? "stopped" : completed.success ? "complete" : "failed",
        success: completed.success,
        timestamp: Date.now(),
        triggerTurn: false,
        awaitedByWorkflow: true,
        parentWorkflowRunId,
    });
}
/** Consumes an awaited workflow child's published result: clears the payload, announces completion, and builds the tool result. */
function importWorkflowAwaitedChildResult(completed, options) {
    if (completed.importedPublication)
        removeWorkflowAwaitedResult(options.asyncDir, options.resultPath, options.runId, completed.importedPublication);
    emitWorkflowAwaitedChildComplete(options.pi, options.state, options.runId, options.asyncDir, options.parentWorkflowRunId, completed);
    const usage = importedAsyncRootUsage(completed);
    const childResult = omitUndefinedProperties({
        index: 0,
        agent: completed.agent,
        ...(completed.sessionName ? { sessionName: completed.sessionName } : {}),
        task: options.task,
        exitCode: completed.exitCode,
        usage,
        finalOutput: completed.output,
        outputState: completed.output.trim() ? "present" : "absent",
        ...(completed.error ? { error: completed.error } : {}),
        ...(completed.timedOut ? { timedOut: true } : {}),
        ...(completed.stopped ? { stopped: true } : {}),
        ...(completed.sessionFile ? { sessionFile: completed.sessionFile } : {}),
        ...(completed.model ? { model: completed.model } : {}),
        ...(completed.requestedModel ? { requestedModel: completed.requestedModel } : {}),
        ...(completed.contextOverflow ? { contextOverflow: true } : {}),
        ...(completed.structuredOutput !== undefined ? { structuredOutput: completed.structuredOutput } : {}),
        ...(completed.structuredOutputPath ? { structuredOutputPath: completed.structuredOutputPath } : {}),
        ...(completed.structuredOutputSchemaPath ? { structuredOutputSchemaPath: completed.structuredOutputSchemaPath } : {}),
        ...(completed.acceptance ? { acceptance: completed.acceptance } : {}),
        ...(completed.artifactPaths ? { artifactPaths: completed.artifactPaths } : {}),
        ...(completed.savedOutputPath ? { savedOutputPath: completed.savedOutputPath } : {}),
        ...(completed.outputSaveError ? { outputSaveError: completed.outputSaveError } : {}),
        ...(completed.transcriptPath ? { transcriptPath: completed.transcriptPath } : {}),
        ...(completed.transcriptError ? { transcriptError: completed.transcriptError } : {}),
    });
    return {
        content: [{ type: "text", text: (completed.success ? completed.output || completed.error : completed.error || completed.output) || (options.emptyOutputText ?? `Async workflow child ${options.runId} completed without output.`) }],
        ...(completed.success ? {} : { isError: true }),
        details: {
            ...options.details,
            runId: options.runId,
            results: [childResult],
        },
    };
}
// A replaced runtime leaves the child running so a relaunch of the workflow can re-attach to it.
function stopAwaitedAsyncChildOnAbort(signal, state, runId, asyncDir, kill) {
    const stopOnAbort = () => { if (!workflowStopCause(signal?.reason))
        stopAsyncRun(state, runId, kill, { asyncDir, resolvedId: runId }); };
    if (signal?.aborted)
        stopOnAbort();
    else
        signal?.addEventListener("abort", stopOnAbort, { once: true });
    return { remove: () => signal?.removeEventListener("abort", stopOnAbort) };
}
// Live workflow controls are keyed by the full run id; a stop id may be a prefix or the launch tool-call id.
function resolveLiveWorkflowRunId(deps, id) {
    const controllers = deps.state.workflowControllers;
    if (!controllers?.size)
        return undefined;
    if (controllers.has(id))
        return id;
    try {
        const resolved = resolveSubagentRunId(id, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
        return resolved?.kind === "async" && controllers.has(resolved.id) ? resolved.id : undefined;
    }
    catch {
        // The generic stop path resolves the id again and reports the error.
        return undefined;
    }
}
async function waitForWorkflowAsyncSingleResult(params, launchResult, options) {
    if (params.workflowAwaitAsync !== true || !launchResult.details.asyncDir)
        return launchResult;
    const asyncDir = launchResult.details.asyncDir;
    const resultPath = workflowAwaitedAsyncResultPath(asyncDir);
    const stopListener = stopAwaitedAsyncChildOnAbort(options.signal, options.state, options.runId, asyncDir, options.kill);
    const completed = await waitForImportedAsyncRoot({ runId: options.runId, asyncDir, resultPath, index: 0 }, omitUndefinedProperties({
        shouldAbort: () => options.signal?.aborted === true,
        timeoutMessage: "Workflow stopped before async child completed.",
        abortedAsStopped: true,
    })).finally(stopListener.remove);
    return importWorkflowAwaitedChildResult(completed, { runId: options.runId, asyncDir, resultPath, task: options.task, parentWorkflowRunId: params.workflowParentRunId, details: launchResult.details, state: options.state, pi: options.pi });
}
async function runAsyncPath(data, deps) {
    const { params, effectiveCwd, agents, ctx, shareEnabled, sessionRoot, sessionFileForTask, thinkingOverrideForTask, artifactConfig, artifactsDir, effectiveAsync, controlConfig, intercomBridge, nestedRoute, contextPolicy, unknownAgentDiagnosticContext, } = data;
    const hasChain = (params.chain?.length ?? 0) > 0;
    const hasTasks = (params.tasks?.length ?? 0) > 0;
    const hasSingle = !hasChain && !hasTasks && Boolean(params.agent);
    if (!effectiveAsync)
        return null;
    if (!isAsyncAvailable()) {
        return {
            content: [{ type: "text", text: "Async mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the pi-subagents package dependencies are installed." }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    const id = data.asyncRunId;
    const parentModel = data.parentModel;
    const asyncCtx = compactOptional({
        pi: deps.pi,
        cwd: ctx.cwd,
        currentSessionId: data.parentSessionId,
        parentSessionId: data.parentPiSessionId,
        currentModelProvider: parentModel?.provider,
        currentModel: parentModel,
        scopedModelIds: data.scopedModelIds,
        modelScope: data.modelScope,
        modelResponseAliases: deps.config.modelResponseAliases,
        interactive: ctx.hasUI,
        permissions: deps.config.permissions,
        childRuntime: deps.childRuntime,
        projectTrusted: sessionProjectTrust(ctx),
    });
    const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
    const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth, deps.childRuntime);
    const currentProvider = parentModel?.provider;
    const controlIntercomTarget = resolveRunLevelIntercomTarget(intercomBridge, contextPolicy);
    const childIntercomTarget = resolveChildIntercomTargetFactory(intercomBridge, contextPolicy, id);
    if (hasSingle) {
        const a = agents.find((x) => x.name === params.agent);
        if (!a) {
            return {
                content: [{ type: "text", text: formatUnknownAgentError(params.agent, unknownAgentDiagnosticContext) }],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        const rawOutput = params.output !== undefined ? params.output : a.output;
        const effectiveOutput = normalizeSingleOutputOverride(rawOutput, a.output);
        const effectiveOutputMode = params.outputMode ?? a.outputMode ?? "inline";
        const normalizedSkills = normalizeSkillInput(params.skill);
        const skills = normalizedSkills === false ? [] : normalizedSkills;
        const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, a.maxSubagentDepth);
        const externalRunnerWithoutExplicitModel = (a.runner?.type === "external-cli" || a.runner?.type === "external-job")
            && params.model === undefined
            && (a.model === undefined || (a.modelSource?.type === "subagents.defaultModel" && a.model === a.modelSource.model));
        if ((a.runner?.type === "external-cli" || a.runner?.type === "external-job") && (params.fast ?? a.fast) === true) {
            return buildRequestedModeError(params, `Agent '${a.name}' uses runner.type='${a.runner.type}' and does not support fast mode.`);
        }
        const modelScopes = resolveModelScopesForAgent(data.modelScope, a.name, parentModel, data.scopedModelIds);
        const modelOrigin = resolveModelOrigin({
            storedOrigin: params.modelOrigin,
            explicitModel: params.model,
            agentModel: a.model,
            parentModel,
        });
        const modelOverride = a.runner?.type === "external-cli" || a.runner?.type === "external-job"
            ? params.model ?? (externalRunnerWithoutExplicitModel ? undefined : a.model)
            : resolveEffectiveSubagentModel(params.model, a.model, parentModel, availableModels, a.modelProvider ?? currentProvider, {
                ...(modelScopes.length === 0 ? {} : { scope: modelScopes }),
                source: modelOrigin === "explicit" ? "explicit" : "inherited",
            });
        const modelOverrideFromParent = modelOrigin === "inherited";
        const launchRuleError = applyWatchdogLaunchRules({ cwd: effectiveCwd, agent: a.name, model: modelOverride ?? (parentModel && `${parentModel.provider}/${parentModel.id}`), warn: (violation) => deps.watchdog?.displayRuleWarning(violation) });
        if (launchRuleError)
            return toExecutionErrorResult(params, new Error(launchRuleError), data.contextPolicy.contextSummary);
        const asyncResult = await executeAsyncSingle(id, compactOptional({
            agent: params.agent,
            task: shouldForkAgent(contextPolicy, params.agent) ? wrapForkTask(params.task ?? "") : (params.task ?? ""),
            goal: params.task ?? "",
            agentConfig: a,
            recoveryAgentConfig: data.recoveryAgents.find((agent) => agent.name === params.agent),
            ctx: asyncCtx,
            availableModels,
            cwd: effectiveCwd,
            requestedCwd: data.requestedCwd,
            machine: params.machine,
            machineCwd: params.machineCwd,
            maxOutput: params.maxOutput,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            shareEnabled,
            activeAsyncCapacity: data.activeAsyncCapacity,
            sessionRoot,
            sessionFile: sessionFileForTask(params.agent, 0, modelOverride, modelOverrideFromParent, modelOrigin),
            context: contextPolicy.contextForAgent(params.agent),
            skills,
            output: effectiveOutput,
            outputMode: effectiveOutputMode,
            outputClaimPath: params.workflowOutputClaimPath,
            ...(params.reads !== undefined ? { reads: params.reads } : {}),
            outputBaseDir: resolveSingleRunOutputBaseDir(deps, artifactsDir, id),
            modelOverride,
            fast: params.fast,
            modelOverrideFromParent,
            modelOrigin,
            thinkingOverride: externalRunnerWithoutExplicitModel ? undefined : thinkingOverrideForTask(),
            thinkingCeiling: a.maxThinking,
            maxSubagentDepth,
            waitToolEnabled: deps.waitToolEnabled,
            waitToolDefaultTimeoutMs: deps.waitToolDefaultTimeoutMs,
            ...(params.worktree === true ? { worktree: true } : {}),
            worktreeSetupHook: deps.config.worktreeSetupHook,
            worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
            worktreeBaseDir: deps.config.worktreeBaseDir,
            baseRef: params.baseRef,
            worktreeProvider: deps.config.worktreeProvider,
            worktreeBranchPrefix: deps.config.worktreeBranchPrefix,
            controlConfig,
            intercomBridge: params.intercomBridge,
            controlIntercomTarget,
            childIntercomTarget: childIntercomTarget ? (agent, index) => childIntercomTarget(agent, index) : undefined,
            nestedRoute,
            agentContract: params.agentContract,
            structuredOutputSchema: params.outputSchema || undefined,
            extensionBindings: params.extensionBindings,
            acceptance: params.acceptance,
            timeoutMs: data.timeoutMs,
            toolBudget: data.toolBudget,
            usageBudget: data.usageBudget,
            configToolBudget: data.configToolBudget,
            toolTimeoutMs: data.params?.toolTimeoutMs,
            checkpointBeforeDeadlineMs: data.params?.checkpointBeforeDeadlineMs ?? deps.config.checkpointBeforeDeadlineMs,
            configToolTimeoutMs: data.configToolTimeoutMs,
            capabilityCeiling: data.capabilityCeiling,
            runFanoutBudget: data.runFanoutBudget,
            parentWorkflowRunId: params.workflowParentRunId,
            workflowKey: params.workflowKey,
            lane: params.lane,
            workflowAwaitAsync: params.workflowAwaitAsync,
        }));
        return waitForWorkflowAsyncSingleResult(params, asyncResult, { runId: id, task: params.task ?? "", signal: data.signal, state: deps.state, pi: deps.pi, kill: deps.kill });
    }
    return null;
}
async function createSingleWorktreeSetup(cwd, runId, agent, setupHook, setupHookTimeoutMs, baseDir, baseRef, provider, branchPrefix, label, task, onProgress, signal, deadlineAt) {
    try {
        return {
            setup: await createWorktrees(cwd, runId, 1, omitUndefinedProperties({
                agents: [agent],
                setupHook: setupHook
                    ? { hookPath: setupHook, ...(setupHookTimeoutMs === undefined ? {} : { timeoutMs: setupHookTimeoutMs }) }
                    : undefined,
                baseDir,
                baseRef,
                provider,
                branchPrefix,
                labels: [label],
                tasks: [task],
                onProgress,
                signal,
                deadlineAt,
            })),
        };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { errorResult: { content: [{ type: "text", text: message }], isError: true, details: { mode: "single", results: [] } } };
    }
}
function resolveConfiguredSingleRunOutputBaseDir(deps) {
    return deps.config.singleRunOutputBaseDir
        ? path.resolve(deps.expandTilde(deps.config.singleRunOutputBaseDir))
        : undefined;
}
export function sanitizeRunPathSegment(value, maxBytes = 120) {
    const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    if (!sanitized)
        return "unknown";
    if (Buffer.byteLength(sanitized, "utf-8") <= maxBytes)
        return sanitized;
    return sanitized.slice(0, maxBytes).replace(/_+$/, "") || "unknown";
}
function resolveSingleRunOutputBaseDir(deps, artifactsDir, runId) {
    return resolveConfiguredSingleRunOutputBaseDir(deps) ?? path.join(artifactsDir, "outputs", sanitizeRunPathSegment(runId));
}
function workflowChildDefaultOutput(aggregateOutputPath, artifactsDir, workflowRunId, workflowKey) {
    if (aggregateOutputPath) {
        const parsed = path.parse(aggregateOutputPath);
        return path.join(parsed.dir, `${parsed.name}.${workflowKey}${parsed.ext || ".md"}`);
    }
    return path.join(artifactsDir, "outputs", sanitizeRunPathSegment(workflowRunId), `${workflowKey}.md`);
}
function workflowHostCommandRunner(input) {
    return async (key, params, signal) => {
        const authorizationError = input.authorize?.(key, params);
        if (authorizationError)
            throw new Error(authorizationError);
        const defaultOutputPath = path.join(input.artifactsDir, "outputs", sanitizeRunPathSegment(input.workflowRunId), "host", `${sanitizeRunPathSegment(key)}.log`);
        const outputPath = params.output ? path.resolve(input.workflowCwd, params.output) : defaultOutputPath;
        const claimPath = resolveWorkflowHostOutputClaimPath(outputPath);
        const previous = input.claimedOutputPaths.get(claimPath);
        if (previous)
            throw new Error(`runs.host('${key}') output path is already claimed by '${previous}': ${outputPath}.`);
        input.claimedOutputPaths.set(claimPath, `host:${key}`);
        const result = await executeWorkflowHostCommand({ key, params, cwd: input.workflowCwd, defaultOutputPath, claimedOutputPath: claimPath, signal });
        input.producedOutputPaths.add(resolveWorkflowHostOutputClaimPath(result.outputPath));
        return result;
    };
}
function writeWorkflowAggregateOutput(outputPath, text, producedChildOutputPaths) {
    if (!outputPath)
        return undefined;
    try {
        if (producedChildOutputPaths.has(resolveWorkflowHostOutputClaimPath(outputPath)))
            return undefined;
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, text, "utf-8");
        return undefined;
    }
    catch (error) {
        return `Output file error: ${outputPath}\n${error instanceof Error ? error.message : String(error)}`;
    }
}
function appendWorkflowOutputWarning(text, warning) {
    return warning ? `${text}\n\n${warning}` : text;
}
const WORKFLOW_TRACE_ERROR_MAX_CHARS = 500;
// Return, emits, console, and trace errors (which carry child text) have no size limit of their
// own, so only they are cut; other host sections stay whole. The saved full result is uncut.
function formatWorkflowResultText(input) {
    const traceSection = (error) => input.trace.length > 0
        ? [`Call trace:\n${input.trace.map((entry) => `${entry.line}${entry.error ? ` — ${error(entry.error)}` : ""}`).join("\n")}`]
        : [];
    const fullText = [...input.head, ...input.script, ...traceSection((error) => error), ...input.tail].join("\n\n");
    const outputWarning = writeWorkflowAggregateOutput(input.aggregateOutputPath, fullText, input.producedChildOutputPaths);
    const scriptText = input.script.join("\n\n");
    const config = { ...DEFAULT_MAX_OUTPUT, ...input.maxOutput };
    const scriptCut = truncateOutput(scriptText, config).truncated;
    const traceCut = input.trace.some((entry) => (entry.error?.length ?? 0) > WORKFLOW_TRACE_ERROR_MAX_CHARS);
    let shownScriptText = scriptText;
    let saveWarning;
    let savedPath;
    if (scriptCut || traceCut) {
        const aggregateHoldsFullText = input.aggregateOutputPath !== undefined && !outputWarning
            && !input.producedChildOutputPaths.has(resolveWorkflowHostOutputClaimPath(input.aggregateOutputPath));
        if (!aggregateHoldsFullText)
            saveWarning = writeWorkflowAggregateOutput(input.fullResultPath, fullText, new Set());
        savedPath = aggregateHoldsFullText ? input.aggregateOutputPath : saveWarning ? undefined : input.fullResultPath;
        if (scriptCut)
            shownScriptText = truncateOutput(scriptText, config, savedPath).text;
    }
    const shownTrace = traceSection((error) => error.length > WORKFLOW_TRACE_ERROR_MAX_CHARS ? `${error.slice(0, WORKFLOW_TRACE_ERROR_MAX_CHARS)}… (+${error.length - WORKFLOW_TRACE_ERROR_MAX_CHARS} chars)` : error);
    const traceNote = traceCut && !scriptCut && savedPath ? [`[TRUNCATED: trace errors shortened - full output at ${savedPath}]`] : [];
    const text = [...input.head, ...(shownScriptText ? [shownScriptText] : []), ...shownTrace, ...input.tail, ...traceNote].join("\n\n");
    return appendWorkflowOutputWarning(appendWorkflowOutputWarning(text, outputWarning), saveWarning);
}
export function resolveWorkflowChildLocalCwd(input) {
    if (input.params.machine !== undefined)
        return input.workflowCwd;
    if (typeof input.params.agent === "string") {
        const agentScope = resolveExecutionAgentScope(input.params.agentScope ?? input.workflowAgentScope);
        const workflowAgents = input.discoverAgents(input.workflowCwd, agentScope).agents;
        const agent = resolveAgentName(input.params.agent, workflowAgents).agent ?? resolveAgentName(input.params.agent, input.agents).agent;
        if (agent?.machine !== undefined)
            return input.workflowCwd;
    }
    return typeof input.params.cwd === "string" ? resolveChildCwd(input.workflowCwd, input.params.cwd) : input.workflowCwd;
}
function resolveWorkflowChildOutputPath(input) {
    const rawOutput = input.params.output;
    const hasExplicitOutput = typeof rawOutput === "string" || typeof rawOutput === "boolean";
    if (typeof input.params.resume === "string" && (!hasExplicitOutput || rawOutput === true || rawOutput === "true")) {
        if (!input.state)
            return { path: undefined, inherited: false };
        const index = input.params.index;
        const target = resolveResumeTarget({
            id: input.params.resume.trim(),
            ...(typeof index === "number" && Number.isInteger(index) ? { index } : {}),
        }, input.state);
        return { path: "recoveryDescriptor" in target ? target.recoveryDescriptor?.outputPath : undefined, inherited: false };
    }
    const childCwd = resolveWorkflowChildLocalCwd(input);
    let agentOutput;
    if (rawOutput === true || rawOutput === "true" || (!hasExplicitOutput && !input.aggregateOutputPath)) {
        const agentScope = resolveExecutionAgentScope(input.params.agentScope ?? input.workflowAgentScope);
        const discoveredAgents = input.discoverAgents(childCwd, agentScope).agents;
        const agent = typeof input.params.agent === "string"
            ? resolveAgentName(input.params.agent, discoveredAgents).agent ?? resolveAgentName(input.params.agent, input.agents).agent
            : undefined;
        agentOutput = typeof agent?.output === "string" ? agent.output : undefined;
    }
    const output = rawOutput === true || rawOutput === "true"
        ? agentOutput
        : hasExplicitOutput
            ? rawOutput
            : input.aggregateOutputPath
                ? workflowChildDefaultOutput(input.aggregateOutputPath, input.artifactsDir, input.workflowRunId, input.key)
                : agentOutput;
    return {
        path: resolveSingleOutputPath(output, input.ctxCwd, childCwd, input.configuredOutputBaseDir ?? path.join(input.artifactsDir, "outputs", sanitizeRunPathSegment(input.workflowRunId))),
        inherited: !hasExplicitOutput && !input.aggregateOutputPath && agentOutput !== undefined,
    };
}
function workflowChildOutputClaims(input) {
    const resolvedEntries = input.entries.map(({ key, params }) => ({
        key,
        ...resolveWorkflowChildOutputPath({ ...input, key, params }),
    }));
    const paths = new Map();
    for (const claimedPath of input.claimedOutputPaths.keys())
        paths.set(claimedPath, 1);
    for (const { path: resolved } of resolvedEntries) {
        if (resolved) {
            const claimPath = resolveWorkflowHostOutputClaimPath(resolved);
            paths.set(claimPath, (paths.get(claimPath) ?? 0) + 1);
        }
    }
    const overrides = new Map();
    for (const entry of resolvedEntries) {
        if (entry.inherited && entry.path && (paths.get(resolveWorkflowHostOutputClaimPath(entry.path)) ?? 0) > 1) {
            const output = workflowChildDefaultOutput(input.aggregateOutputPath, input.artifactsDir, input.workflowRunId, entry.key);
            overrides.set(entry.key, output);
            entry.path = output;
        }
    }
    const claims = new Map(input.claimedOutputPaths);
    const childClaims = new Map();
    for (const { key, path: resolved } of resolvedEntries) {
        if (!resolved)
            continue;
        const claimPath = resolveWorkflowHostOutputClaimPath(resolved);
        const previous = claims.get(claimPath);
        if (previous)
            return { error: `Workflow children '${previous}' and '${key}' resolve output to the same path: ${resolved}. Use distinct child output paths.` };
        claims.set(claimPath, key);
        childClaims.set(key, claimPath);
    }
    return { claims, childClaims, overrides };
}
function applyWorkflowChildOutputClaims(target, claims) {
    target.clear();
    for (const [resolved, key] of claims)
        target.set(resolved, key);
}
function prepareWorkflowChildLaunchParams(input) {
    let childParams = input.childParams;
    const usesDefaultOutput = input.childParams.output === undefined && input.childParams.resume === undefined;
    if (usesDefaultOutput && input.outputOverride !== undefined) {
        childParams = { ...input.childParams, output: input.outputOverride };
    }
    else if (usesDefaultOutput && input.aggregateOutputPath !== undefined) {
        childParams = { ...input.childParams, output: workflowChildDefaultOutput(input.aggregateOutputPath, input.artifactsDir, input.parentWorkflowRunId, input.workflowKey) };
    }
    else if (input.childParams.resume === undefined || input.childParams.output !== undefined) {
        const resolvedOutput = resolveWorkflowChildOutputPath({ ctxCwd: input.ctxCwd, workflowCwd: input.workflowCwd, artifactsDir: input.artifactsDir, workflowRunId: input.parentWorkflowRunId, aggregateOutputPath: input.aggregateOutputPath, configuredOutputBaseDir: input.configuredOutputBaseDir, discoverAgents: input.discoverAgents, agents: input.agents, workflowAgentScope: input.workflowAgentScope, key: input.workflowKey, params: input.childParams });
        if (resolvedOutput.path)
            childParams = { ...input.childParams, output: resolvedOutput.path };
    }
    const childCwd = resolveWorkflowChildLocalCwd({ ...input, params: childParams });
    const agentScope = resolveExecutionAgentScope(childParams.agentScope ?? input.workflowAgentScope);
    const discoveredAgents = input.discoverAgents(childCwd, agentScope).agents;
    const agent = typeof childParams.agent === "string"
        ? resolveAgentName(childParams.agent, discoveredAgents).agent ?? resolveAgentName(childParams.agent, input.agents).agent
        : undefined;
    const externalAsyncRequired = agent?.runner?.type === "external-cli" || agent?.runner?.type === "external-job";
    return prepareWorkflowLaunchParams(input.workflowDefaults, childParams, input.parentWorkflowRunId, input.workflowKey, { ...input.options, externalAsyncRequired, outputClaimPath: input.outputClaimPath });
}
async function finalizeSingleWorktreeHandoff(input) {
    let admitted = false;
    try {
        return await withWorktreeTransaction(() => {
            admitted = true;
            const diffsDir = path.join(input.artifactsDir, "worktree-diffs", input.runId);
            const diffs = diffWorktrees(input.worktreeSetup, [input.agent], diffsDir);
            const diffSummary = formatWorktreeDiffSummary(diffs);
            const manifestPath = parallelHandoffPath(input.artifactsDir, input.runId);
            const handoff = {
                manifestPath,
                runId: input.runId,
                mode: "single",
                source: "foreground",
                cwd: input.cwd,
                stepIndex: 0,
                flatStartIndex: 0,
                setup: input.worktreeSetup,
                laneBindings: input.workflowKey || input.lane ? [{ index: 0, taskIndex: 0, ...(input.workflowKey ? { workflowKey: input.workflowKey } : {}), runId: input.workflowKey ? input.runId : undefined, ...(input.lane ? { lane: input.lane } : {}) }] : undefined,
                diffs,
                results: [{
                        agent: input.result.agent,
                        ...(input.workflowKey ? { workflowKey: input.workflowKey } : {}),
                        ...(input.workflowKey ? { runId: input.runId } : {}),
                        ...(input.lane ? { lane: input.lane } : {}),
                        status: resolveSubagentResultStatus(omitUndefinedProperties({
                            exitCode: input.result.exitCode,
                            interrupted: input.result.interrupted,
                            detached: input.result.detached,
                            state: input.result.stopped ? "stopped" : undefined,
                            processSignal: input.result.processSignal,
                            timedOut: input.result.timedOut,
                            stopped: input.result.stopped,
                            turnBudgetExceeded: input.result.turnBudgetExceeded,
                        })),
                        summary: resultSummaryForIntercom(input.result),
                        ...(input.result.artifactPaths?.outputPath ? { outputPath: input.result.artifactPaths.outputPath } : {}),
                        ...(input.result.structuredOutput !== undefined ? { structuredOutput: input.result.structuredOutput } : {}),
                        ...(input.result.structuredOutputPath ? { structuredOutputPath: input.result.structuredOutputPath } : {}),
                        ...(input.result.sessionFile ? { sessionPath: input.result.sessionFile } : {}),
                    }],
            };
            try {
                writeParallelHandoffGroup(handoff);
                const cleanup = cleanupWorktrees(input.worktreeSetup, { kind: "preserve", capturedDiffs: diffs, handoffManifestPath: manifestPath });
                const reference = writeParallelHandoffGroup({ ...handoff, cleanup });
                return {
                    suffix: [diffSummary, formatParallelHandoffReference(reference)].filter(Boolean).join("\n\n"),
                    reference,
                };
            }
            catch (error) {
                return { suffix: [diffSummary, formatParallelHandoffError(error)].filter(Boolean).join("\n\n") };
            }
        });
    }
    catch (error) {
        if (admitted)
            throw error;
        const reference = retainSingleWorktreeHandoff(input, error);
        return { suffix: `${formatParallelHandoffError(error)}\n\n${formatParallelHandoffReference(reference)}`, reference };
    }
}
function retainSingleWorktreeHandoff(input, error) {
    const reason = `Worktree finalization retained; manual reconciliation required: ${error instanceof Error ? error.message : String(error)}`;
    return writeParallelHandoffGroup({
        manifestPath: parallelHandoffPath(input.artifactsDir, input.runId), runId: input.runId,
        mode: "single", source: "foreground", cwd: input.cwd, stepIndex: 0, flatStartIndex: 0,
        setup: input.worktreeSetup, diffs: [], results: [],
        cleanup: { state: "partial", pruned: false, errors: [reason], tasks: input.worktreeSetup.worktrees.map((worktree) => ({
                index: worktree.index, path: worktree.path, branch: worktree.branch, provider: worktree.provider, naming: worktree.naming,
                worktreeRemoved: false, branchRemoved: false, preserved: true, reason,
            })) },
    });
}
async function runSinglePath(data, deps) {
    const { params, effectiveCwd, agents, ctx, signal, runId, sessionDirForIndex, sessionFileForTask, thinkingOverrideForTask, shareEnabled, artifactConfig, artifactsDir, onUpdate, controlConfig, contextPolicy, suppressUnchangedDelegationUpdates, } = data;
    let lane;
    try {
        lane = normalizeWorkflowLaneMetadata(params.lane, "lane");
        assertWorkflowLaneKey(lane, params.workflowKey, "lane");
    }
    catch (error) {
        return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "single", results: [] } };
    }
    const onControlEvent = createForegroundControlNotifier(data, deps);
    const childBridgeActive = intercomBridgeAppliesToAgent(data.intercomBridge, contextPolicy, params.agent);
    const childIntercomTarget = childBridgeActive ? resolveSubagentIntercomTarget(runId, params.agent, 0) : undefined;
    const allProgress = [];
    const allArtifactPaths = [];
    const agentConfig = agents.find((a) => a.name === params.agent);
    if (!agentConfig) {
        return {
            content: [{ type: "text", text: formatUnknownAgentError(params.agent, data.unknownAgentDiagnosticContext) }],
            isError: true,
            details: { mode: "single", results: [] },
        };
    }
    let foregroundMachine;
    const requestedMachine = params.machine ?? agentConfig.machine;
    if (requestedMachine) {
        try {
            foregroundMachine = resolveHerdrMachinePlacement({ machine: requestedMachine, cwd: ctx.cwd, stepCwd: params.machineCwd }).machine;
        }
        catch (error) {
            return toExecutionErrorResult(params, error instanceof Error ? error : new Error(String(error)), data.contextPolicy.contextSummary);
        }
    }
    const effectiveToolBudget = resolveEffectiveToolBudget(omitUndefinedProperties({ runBudget: data.toolBudget, agentBudget: agentConfig.toolBudget, configBudget: data.configToolBudget }));
    if (effectiveToolBudget.error)
        return toExecutionErrorResult(params, new Error(effectiveToolBudget.error), data.contextPolicy.contextSummary);
    const parentModel = data.parentModel;
    const currentProvider = parentModel?.provider;
    const availableModels = ctx.modelRegistry.getAvailable().map(toModelInfo);
    const modelScopes = resolveModelScopesForAgent(data.modelScope, agentConfig.name, parentModel, data.scopedModelIds);
    let task = typeof params.task === "string" ? params.task : "";
    const modelOrigin = resolveModelOrigin({
        storedOrigin: params.modelOrigin,
        explicitModel: params.model,
        agentModel: agentConfig.model,
        parentModel,
    });
    let modelOverride = resolveEffectiveSubagentModel(params.model, agentConfig.model, parentModel, availableModels, agentConfig.modelProvider ?? currentProvider, {
        ...(modelScopes.length === 0 ? {} : { scope: modelScopes }),
        source: modelOrigin === "explicit" ? "explicit" : "inherited",
    });
    const modelOverrideFromParent = modelOrigin === "inherited";
    const launchRuleError = applyWatchdogLaunchRules({ cwd: effectiveCwd, agent: agentConfig.name, model: modelOverride ?? (parentModel && `${parentModel.provider}/${parentModel.id}`), warn: (violation) => deps.watchdog?.displayRuleWarning(violation) });
    if (launchRuleError)
        return toExecutionErrorResult(params, new Error(launchRuleError), data.contextPolicy.contextSummary);
    let skillOverride = normalizeSkillInput(params.skill);
    let readsOverride = params.reads;
    const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
    let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
    const effectiveOutputMode = params.outputMode ?? agentConfig.outputMode ?? "inline";
    const currentMaxSubagentDepth = resolveCurrentMaxSubagentDepth(deps.config.maxSubagentDepth, deps.childRuntime);
    const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);
    const sourceCwd = foregroundMachine?.cwd ?? effectiveCwd;
    let pendingHandoff;
    const { setup: worktreeSetup, errorResult: worktreeSetupError } = params.worktree ? await createSingleWorktreeSetup(sourceCwd, runId, params.agent, deps.config.worktreeSetupHook, deps.config.worktreeSetupHookTimeoutMs, deps.config.worktreeBaseDir, params.baseRef, deps.config.worktreeProvider, deps.config.worktreeBranchPrefix, params.lane?.key ?? params.workflowKey, task, (progress) => {
        pendingHandoff = writeWorktreeSetupHandoff({
            manifestPath: parallelHandoffPath(artifactsDir, runId),
            runId,
            mode: "single",
            source: "foreground",
            cwd: sourceCwd,
            stepIndex: 0,
            flatStartIndex: 0,
            progress,
            laneBindings: params.workflowKey || lane ? [{ index: 0, taskIndex: 0, ...(params.workflowKey ? { workflowKey: params.workflowKey, runId } : {}), ...(lane ? { lane } : {}) }] : undefined,
        });
    }, signal, data.deadlineAt) : {};
    if (worktreeSetupError) {
        if (pendingHandoff) {
            worktreeSetupError.details.parallelHandoff = pendingHandoff;
            worktreeSetupError.content.push({ type: "text", text: formatParallelHandoffReference(pendingHandoff) });
        }
        return worktreeSetupError;
    }
    const singleCwd = worktreeSetup?.worktrees[0]?.agentCwd ?? sourceCwd;
    const cleanupSingleWorktree = async () => {
        if (!worktreeSetup)
            return;
        let admitted = false;
        try {
            await withWorktreeTransaction(() => {
                if (data.deadlineAt !== undefined && Date.now() >= data.deadlineAt)
                    throw new Error("Run deadline expired before unlaunched worktree cleanup");
                admitted = true;
                const cleanup = cleanupWorktrees(worktreeSetup);
                pendingHandoff = writeParallelHandoffGroup({
                    manifestPath: parallelHandoffPath(artifactsDir, runId), runId, mode: "single", source: "foreground",
                    cwd: sourceCwd, stepIndex: 0, flatStartIndex: 0, setup: worktreeSetup, diffs: [], results: [], cleanup,
                });
            });
        }
        catch (error) {
            if (admitted)
                throw error;
            pendingHandoff = retainSingleWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: sourceCwd }, error);
        }
    };
    if (worktreeSetup && (signal?.aborted || (data.deadlineAt !== undefined && Date.now() >= data.deadlineAt))) {
        await cleanupSingleWorktree();
        return { content: [{ type: "text", text: "Subagent setup canceled before child launch." }], isError: true, details: { mode: "single", results: [], parallelHandoff: pendingHandoff } };
    }
    const authoredTask = task;
    if (shouldForkAgent(contextPolicy, params.agent)) {
        task = wrapForkTask(task);
    }
    const cleanTask = task;
    const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, singleCwd, resolveSingleRunOutputBaseDir(deps, artifactsDir, runId));
    const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
    if (validationError) {
        await cleanupSingleWorktree();
        return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [], parallelHandoff: pendingHandoff } };
    }
    const structuredRuntime = params.outputSchema
        ? createStructuredOutputRuntime(params.outputSchema, artifactConfig.enabled ? path.join(artifactsDir, "structured-output", runId) : undefined, { acceptanceReport: resolveAcceptanceReportMode(params.acceptance) })
        : undefined;
    // Reads: caller override > agent defaultReads > none. `~`/`~/` expand to home;
    // absolute paths pass through; relative paths resolve against the child cwd.
    const reads = readsOverride !== undefined ? readsOverride : agentConfig.defaultReads ?? false;
    const readPaths = !foregroundMachine && Array.isArray(reads) ? resolveExistingReadPaths(reads, singleCwd) : [];
    const readsInstruction = readPaths.length > 0
        ? `[Read from: ${readPaths.join(", ")}]\n\n`
        : "";
    task = readsInstruction + task;
    task = injectSingleOutputInstruction(task, outputPath, agentConfig);
    let effectiveSkills;
    if (skillOverride === false) {
        effectiveSkills = [];
    }
    else {
        effectiveSkills = skillOverride;
    }
    const interruptController = new AbortController();
    let detachForeground;
    let childSessionControls;
    const foregroundControl = deps.state.foregroundControls.get(runId);
    const syncHerdrForegroundChild = () => {
        if (!foregroundControl?.parentWorkflowRunId)
            return;
        try {
            deps.pi.events.emit(HERDR_FOREGROUND_CONTROL_CHANGED_EVENT, { runId: foregroundControl.parentWorkflowRunId });
        }
        catch (error) {
            console.error("Failed to sync Herdr foreground child:", error);
        }
    };
    const finishTrackedForegroundChild = () => {
        if (!foregroundControl)
            return;
        const wasActive = foregroundControl.activeChildren?.has(0) === true;
        finishForegroundChild(foregroundControl, 0);
        if (wasActive)
            syncHerdrForegroundChild();
    };
    if (foregroundControl) {
        const thinking = resolveEffectiveThinking(modelOverride, thinkingOverrideForTask());
        beginForegroundChild(foregroundControl, omitUndefinedProperties({
            index: 0,
            agent: params.agent,
            authoredTask,
            effectivePrompt: task,
            cwd: singleCwd,
            outputPath,
            rerun: { params: { ...params, task: authoredTask, async: params.async ?? false } },
            description: foregroundControl.description,
            ...(modelOverride ? { model: modelOverride } : {}),
            ...(thinking ? { thinking } : {}),
            interrupt: () => {
                if (interruptController.signal.aborted)
                    return false;
                interruptController.abort();
                return true;
            },
            detach: () => detachForeground?.("user request") === true,
            steer: async (input) => {
                if (!childSessionControls)
                    return { state: "failed", reason: CHILD_SESSION_NOT_RUNNING_YET };
                try {
                    if (input.mode === "follow_up") {
                        await childSessionControls.followUp(input.message);
                        return { state: "queued" };
                    }
                    await childSessionControls.steer(input.message);
                    return { state: "delivered" };
                }
                catch (error) {
                    return { state: "failed", reason: error instanceof Error ? error.message : String(error) };
                }
            },
        }));
        // Capture the owned mailbox before a child can start and finish between polling ticks.
        if (deps.childRuntime?.fanoutChild)
            deps.activateSupervisorTransport?.();
        syncHerdrForegroundChild();
    }
    const modelResponseAliases = deps.config.modelResponseAliases === undefined ? undefined : structuredClone(deps.config.modelResponseAliases);
    const forwardSingleUpdate = onUpdate
        ? (update) => {
            if (foregroundControl)
                updateForegroundChild(foregroundControl, 0, update.details?.progress?.[0]);
            onUpdate(update);
        }
        : undefined;
    const deadlineAt = data.deadlineAt ?? (data.timeoutMs !== undefined ? Date.now() + data.timeoutMs : undefined);
    const requiredExtensions = deps.childRuntime?.requiredExtensions ?? resolveRequiredChildExtensions(data.parentPiSessionId);
    let r;
    let resolveDetachedWorkflowChild;
    const detachedWorkflowChild = params.workflowAwaitDetached === true
        ? new Promise((resolve) => { resolveDetachedWorkflowChild = resolve; })
        : undefined;
    try {
        const launched = await runSync(ctx.cwd, agents, params.agent, task, compactOptional({
            machine: foregroundMachine,
            parentProviderRegistry: ctx.modelRegistry,
            projectTrusted: sessionProjectTrust(ctx),
            remoteReads: foregroundMachine ? readsOverride : undefined,
            permissions: deps.config.permissions,
            runtimeSnapshotHost: deps.pi,
            parentSessionId: ctx.sessionManager.getSessionId() ?? undefined,
            requiredExtensions,
            childRuntime: deps.childRuntime,
            onChildSession: (controls) => { childSessionControls = controls; },
            context: data.contextPolicy.contextForAgent(params.agent),
            unknownAgentDiagnosticContext: data.unknownAgentDiagnosticContext,
            runFanoutBudget: params.runFanoutAdmitted ? data.runFanoutBudget : { ...data.runFanoutBudget, parentPath: `${data.runFanoutBudget.parentPath ? `${data.runFanoutBudget.parentPath}/` : ""}single` },
            cwd: singleCwd,
            requestedCwd: data.requestedCwd,
            signal,
            abortedAsStopped: params.workflowParentRunId !== undefined,
            interruptSignal: interruptController.signal,
            allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
            intercomEvents: deps.pi.events,
            runId,
            sessionDir: sessionDirForIndex(0),
            sessionFile: sessionFileForTask(params.agent, 0, modelOverride, modelOverrideFromParent, modelOrigin),
            share: shareEnabled,
            artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
            artifactConfig,
            maxOutput: params.maxOutput,
            outputPath,
            outputClaimPath: params.workflowOutputClaimPath,
            outputMode: effectiveOutputMode,
            maxSubagentDepth,
            waitToolEnabled: deps.waitToolEnabled,
            waitToolDefaultTimeoutMs: deps.waitToolDefaultTimeoutMs,
            onUpdate: forwardSingleUpdate,
            suppressUnchangedDelegationUpdates,
            controlConfig,
            onControlEvent,
            intercomSessionName: childIntercomTarget,
            orchestratorIntercomTarget: childBridgeActive ? data.intercomBridge.orchestratorTarget : undefined,
            nestedRoute: foregroundControl?.nestedRoute,
            index: 0,
            modelOverride,
            fast: params.fast,
            modelOverrideFromParent,
            modelOrigin,
            thinkingOverride: thinkingOverrideForTask(),
            thinkingCeiling: agentConfig.maxThinking,
            extensionBindings: params.extensionBindings,
            availableModels,
            modelResponseAliases,
            preferredModelProvider: currentProvider,
            modelScope: modelScopes,
            skills: effectiveSkills,
            structuredOutput: structuredRuntime,
            agentContract: params.agentContract,
            acceptance: params.acceptance,
            acceptanceContext: { mode: "single" },
            workflowChildPermitLaunch: data.workflowChildPermitLaunch,
            onEffectivePrompt: foregroundControl ? (prompt) => updateLiveEffectivePrompt(foregroundControl, 0, prompt) : undefined,
            onDetachReady: (detach) => {
                detachForeground = detach;
            },
            onDetachedExit: async (result) => {
                if (resolveDetachedWorkflowChild) {
                    resolveDetachedWorkflowChild(result);
                    return;
                }
                try {
                    if (worktreeSetup) {
                        await finalizeSingleWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: sourceCwd, agent: params.agent, result, workflowKey: params.workflowKey, lane });
                    }
                    try {
                        updateRememberedForegroundChild(deps.state, { runId, mode: "single", cwd: singleCwd, sessionId: data.parentSessionId, index: 0, result, events: deps.pi.events, notify: true });
                    }
                    catch {
                        // Remembered foreground state is best-effort; run history and cleanup must still complete.
                    }
                    const workflowParentRunId = params.workflowParentRunId ?? foregroundControl?.parentWorkflowRunId;
                    if (workflowParentRunId) {
                        reconcileDetachedWorkflowChildCompletion({
                            state: deps.state,
                            workflowRunId: workflowParentRunId,
                            childRunId: runId,
                            result,
                            events: deps.pi.events,
                            workflowKey: params.workflowKey ?? foregroundControl?.workflowKey,
                        });
                    }
                }
                finally {
                    try {
                        if (!artifactConfig.enabled)
                            cleanupStructuredOutputRuntime(structuredRuntime);
                    }
                    finally {
                        try {
                            finishTrackedForegroundChild();
                        }
                        finally {
                            removeForegroundControlIfIdle(deps.state, runId, deps.trackRetainedNestedRoute);
                        }
                    }
                }
                recordRun(params.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0, result);
            },
            timeoutMs: data.timeoutMs,
            deadlineAt,
            toolTimeoutMs: params.toolTimeoutMs,
            configToolTimeoutMs: data.configToolTimeoutMs,
            toolBudget: effectiveToolBudget.toolBudget,
            usageBudget: data.usageBudget ?? data.inheritedUsageBudget,
            capabilityCeiling: data.capabilityCeiling,
            allowZeroToolBudget: data.allowZeroToolBudget && effectiveToolBudget.toolBudget === data.toolBudget,
        }));
        r = launched.detached && detachedWorkflowChild ? await detachedWorkflowChild : launched;
    }
    catch (error) {
        await cleanupSingleWorktree();
        throw error;
    }
    finally {
        // An attached runSync rejection still owns its child and structured runtime.
        // A successful detached receipt transfers both to onDetachedExit while the
        // authoritative completion remains live.
        if (!r?.detached) {
            if (!artifactConfig.enabled)
                cleanupStructuredOutputRuntime(structuredRuntime);
            finishTrackedForegroundChild();
        }
    }
    if (!r.detached) {
        recordRun(params.agent, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0, r);
    }
    let worktreeHandoff;
    if (worktreeSetup) {
        worktreeHandoff = r.detached
            ? { suffix: pendingHandoff ? formatParallelHandoffReference(pendingHandoff) : "", reference: pendingHandoff }
            : await finalizeSingleWorktreeHandoff({ worktreeSetup, artifactsDir, runId, cwd: sourceCwd, agent: params.agent, result: r, workflowKey: params.workflowKey, lane });
    }
    if (r.progress)
        allProgress.push(r.progress);
    if (r.artifactPaths)
        allArtifactPaths.push(r.artifactPaths);
    const fullOutput = getSingleResultOutput(r);
    const preserveRejectedSavedOutput = r.acceptance?.explicit && r.acceptance.status === "rejected" && r.savedOutputPath !== undefined;
    const finalizedOutput = finalizeSingleOutput(omitUndefinedProperties({
        fullOutput,
        truncatedOutput: r.truncation?.text,
        outputPath,
        outputMode: r.outputMode,
        exitCode: r.exitCode,
        preserveSavedOutput: preserveRejectedSavedOutput,
        savedPath: r.savedOutputPath,
        outputReference: r.outputReference,
        saveError: r.outputSaveError,
    }));
    if (foregroundControl) {
        updateForegroundNestedProjection(foregroundControl);
        attachRootChildrenToSteps(runId, [r], foregroundControl.nestedChildren);
    }
    const totalCost = sumResultsCost([r]);
    const details = compactForegroundDetails(compactOptional({
        mode: "single",
        runId,
        timeoutMs: data.timeoutMs,
        results: [r],
        ...(effectiveToolBudget.toolBudget ? { toolBudget: effectiveToolBudget.toolBudget } : {}),
        progress: params.includeProgress ? allProgress : undefined,
        artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
        truncation: r.truncation,
        totalChildUsage: sumResultsUsage([r]),
        totalCost,
        usageBudget: usageBudgetState(data.usageBudget, totalCost),
        ...(worktreeHandoff?.reference ? { parallelHandoff: worktreeHandoff.reference } : {}),
    }));
    rememberForegroundRun(deps.state, { modelResponseAliases, runId, mode: "single", cwd: singleCwd, sessionId: data.parentSessionId, results: details.results, params, effectiveOutput, effectiveOutputMode, extensionBindings: params.extensionBindings, requiredExtensions });
    const suppressRoutineResultIntercom = shouldSuppressRoutineResultIntercom({ suppressRoutineResultIntercom: params.suppressRoutineResultIntercom, results: [r] });
    if (!r.detached && !r.interrupted && !suppressRoutineResultIntercom) {
        if (foregroundControl)
            updateForegroundNestedProjection(foregroundControl);
        const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
            pi: deps.pi,
            intercomBridge: data.intercomBridge,
            runId,
            mode: "single",
            details,
            ...(params.workflowParentRunId !== undefined ? { preserveDetailsOutputs: true } : {}),
            ...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
        });
        if (intercomReceipt) {
            return {
                content: [{ type: "text", text: intercomReceipt.text }],
                details: intercomReceipt.details,
                ...(r.exitCode !== 0 ? { isError: true } : {}),
            };
        }
    }
    const worktreeSuffix = worktreeHandoff?.suffix ? `\n\n${worktreeHandoff.suffix}` : "";
    if (r.detached) {
        const statusRecovery = `subagent({ action: "status", id: "${runId}" }) to recover the result; do not resume or launch a replacement while it remains detached.`;
        const blockingRecovery = `bg_wait({ id: "${runId}" }). Use ${statusRecovery}`;
        const message = r.detachedReason === "intercom coordination"
            ? `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first, then wait with ${blockingRecovery}`
            : r.detachedReason === "user request"
                ? `Detached at user request: ${params.agent}. The child continues independently. Register a completion wake-up with bg_wait({ id: "${runId}", nonBlocking: true }), or use ${statusRecovery}`
                : `Detached before task completion: ${params.agent}. Wait with ${blockingRecovery}`;
        return {
            content: [{ type: "text", text: `${message}${worktreeSuffix}` }],
            details,
        };
    }
    if (r.interrupted) {
        return {
            content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.${worktreeSuffix}` }],
            details,
        };
    }
    if (r.exitCode !== 0)
        return {
            content: [{ type: "text", text: `${formatFailedSingleRunOutput(r, finalizedOutput.displayOutput)}${worktreeSuffix}` }],
            details,
            isError: true,
        };
    return {
        content: [{ type: "text", text: `${finalizedOutput.displayOutput || "(no output)"}${worktreeSuffix}` }],
        details,
    };
}
function inferExecutionMode(params) {
    if (params.workflowScript !== undefined || params.workflow !== undefined)
        return "workflow";
    if ((params.chain?.length ?? 0) > 0)
        return "chain";
    if ((params.tasks?.length ?? 0) > 0)
        return "parallel";
    return "single";
}
function duplicateSubagentCallResult(params) {
    return {
        content: [{
                type: "text",
                text: "Rejected: a subagent call is already in progress. Issue exactly ONE subagent call per turn.",
            }],
        isError: true,
        details: { mode: inferExecutionMode(params), results: [] },
    };
}
const workflowLaunchObservers = new WeakMap();
const workflowOwnedUsageBudgets = new WeakMap();
/**
 * Terminal-mission retention can remove a mission while its children still
 * report. Remember it to prevent later heartbeats from warning repeatedly.
 */
const missionsMissingFromStore = new Set();
function recordMissionWorkflowChild(binding, workflowRunId, key, update) {
    if (!binding || missionsMissingFromStore.has(binding.missionId))
        return;
    const { task: _task, ...durableUpdate } = update;
    try {
        updateMission(binding.location, binding.missionId, { upsertWorkflowChildren: [{ workflowRunId, key, ...durableUpdate }] });
    }
    catch (error) {
        if (error instanceof MissionNotFoundError) {
            missionsMissingFromStore.add(binding.missionId);
            console.warn(`[pi-subagents] Mission '${binding.missionId}' is no longer in the mission store; stopped recording its workflow children. Terminal-mission retention can prune a mission while its run is still active.`);
            return;
        }
        console.warn(`[pi-subagents] Failed to record mission workflow child '${key}': ${error instanceof Error ? error.message : String(error)}`);
    }
}
export function missionWorkflowChildStatus(result) {
    const childResults = result.details.results;
    if (childResults.some((child) => child.detached || child.interrupted))
        return "paused";
    if (result.isError === true || childResults.some((child) => child.exitCode !== 0))
        return "failed";
    if (childResults.length === 0 && (result.details.asyncId || result.details.asyncDir))
        return "running";
    return "completed";
}
export async function runMissionWorkflowChild(binding, workflowRunId, key, phase, run) {
    try {
        return await run();
    }
    catch (error) {
        recordMissionWorkflowChild(binding, workflowRunId, key, {
            status: "failed",
            completedAt: new Date().toISOString(),
            heartbeat: { status: "failed", ...(phase ? { phase } : {}), message: error instanceof Error ? error.message : String(error) },
        });
        throw error;
    }
}
export function bindMissionWorkflowChildAsyncLaunch(params, binding, asyncByDefault, asyncId = randomUUID(), nestedRootRunId) {
    const requestedAsync = params.async ?? asyncByDefault;
    if (!binding || !requestedAsync || params.clarify === true)
        return params;
    const id = asyncId.trim();
    if (!id || path.basename(id) !== id)
        throw new Error("workflow child async id must be a single path segment");
    writeMissionAsyncBinding(path.join(nestedRootRunId ? nestedRunScope(nestedRootRunId).asyncDirRoot : DIRS.async, id), binding);
    return { ...params, workflowChildAsyncId: id };
}
function workflowChildResult(key, result, childParams = {}, resumeState, forcedTerminalOutcome) {
    const running = missionWorkflowChildStatus(result) === "running";
    const receiptOutput = result.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
    const output = running ? "" : result.details.results.length === 1 && result.details.results[0]?.finalOutput !== undefined
        ? result.details.results[0].finalOutput
        : receiptOutput;
    const childError = result.details.results.map((child) => child.error).find((error) => Boolean(error));
    const stopped = result.details.results.some((child) => child.stopped);
    // A stopped child's receipt text carries the run fan-out annotation; report the structured stop reason instead.
    const failureErrorBase = stopped && childError
        ? childError
        : childError && receiptOutput
            ? receiptOutput.includes(childError) ? receiptOutput : `${childError}\n\n${receiptOutput}`
            : childError || receiptOutput || output || "Child run failed.";
    const savedOutputEvidence = [...new Set(result.details.results.map((child) => child.savedOutputPath).filter((value) => Boolean(value)))]
        .filter((savedOutputPath) => !failureErrorBase.includes(savedOutputPath))
        .map((savedOutputPath) => `Saved output: ${savedOutputPath}`);
    const failureError = [failureErrorBase, ...savedOutputEvidence].join("\n");
    const detached = result.details.results.some((child) => child.detached);
    const interrupted = result.details.results.some((child) => child.interrupted);
    const terminalOutcome = forcedTerminalOutcome
        ?? (result.details.results.some((child) => child.timedOut)
            ? { state: "partial", reason: "timeout" }
            : result.details.usageBudget?.exhausted || result.details.results.some((child) => child.turnBudgetExceeded || child.toolBudgetBlocked)
                ? { state: "partial", reason: "budget_exhausted" }
                : undefined);
    const acceptanceRecovery = result.details.results.find((child) => child.acceptance?.recovery)?.acceptance?.recovery;
    const ok = result.isError !== true && !running && !detached && !interrupted && !stopped && acceptanceRecovery === undefined;
    const artifactPaths = new Set();
    if (result.details.asyncDir)
        artifactPaths.add(result.details.asyncDir);
    if (result.details.parallelHandoff?.path)
        artifactPaths.add(result.details.parallelHandoff.path);
    for (const child of result.details.results) {
        if (child.savedOutputPath)
            artifactPaths.add(child.savedOutputPath);
        if (child.outputReference?.path)
            artifactPaths.add(child.outputReference.path);
        if (child.sessionFile)
            artifactPaths.add(child.sessionFile);
    }
    const structured = result.details.results.map((child) => child.structuredOutput).filter((value) => value !== undefined);
    const resolvedAgents = [...new Set(result.details.results.map((child) => child.agent).filter((agent) => Boolean(agent)))];
    const resolvedContexts = [...new Set(result.details.results.map((child) => child.context).filter((context) => context === "fresh" || context === "fork"))];
    const runId = result.details.runId ?? result.details.asyncId;
    let resumability;
    if (!runId || !resumeState) {
        resumability = { state: "not-resumable", reason: runId ? "resumability was not inspected" : "child produced no run id" };
    }
    else {
        try {
            const target = resolveResumeTarget({ id: runId }, resumeState, { asyncRequireSessionFile: true, exactOnly: true });
            resumability = target.kind === "revive"
                ? { state: "resumable" }
                : { state: "not-resumable", reason: "child is still running" };
        }
        catch (error) {
            resumability = { state: "not-resumable", reason: error instanceof Error ? error.message : String(error) };
        }
    }
    const requestedContext = childParams.context === "fresh" || childParams.context === "fork" ? childParams.context : undefined;
    const resolvedContext = result.details.context ?? (resolvedContexts.length === 1 ? resolvedContexts[0] : resolvedContexts.length > 1 ? "mixed" : undefined);
    const outputReference = result.details.results.find((child) => child.savedOutputPath)?.savedOutputPath
        ?? result.details.results.find((child) => child.outputReference?.path)?.outputReference?.path;
    const outputArtifactPath = running ? undefined : result.details.parallelHandoff?.path
        ?? result.details.results.find((child) => child.artifactPaths?.outputPath)?.artifactPaths?.outputPath;
    const outputPathMapping = typeof childParams.task === "string" ? outputPathMappingFromTask(childParams.task, outputReference) : undefined;
    const externalResult = result.details.results.length === 1 && result.details.results[0]?.runner?.type === "external-cli" ? result.details.results[0] : undefined;
    const externalStatus = result.details.asyncDir ? readStatus(result.details.asyncDir) : undefined;
    const externalStatusStep = externalStatus?.steps?.length === 1 && externalStatus.steps[0]?.runner?.type === "external-cli" ? externalStatus.steps[0] : undefined;
    const externalRunner = normalizeExternalCliRunnerStatus(externalResult?.runner ?? externalStatusStep?.runner);
    const externalProcess = externalResult?.externalProcess ?? externalStatusStep?.externalProcess;
    const externalAdapter = externalRunner ? externalCliReceiptMetadata({ runner: externalRunner, externalProcess, outputReference }) : undefined;
    if (externalAdapter)
        resumability = { state: "not-resumable", reason: externalAdapter.nonResumableReason };
    const lane = normalizeWorkflowLaneMetadata(childParams.lane, `workflow child '${key}'.lane`);
    assertWorkflowLaneKey(lane, key, `workflow child '${key}'.lane`);
    return {
        key,
        ok,
        ...(running ? { state: "running" } : {}),
        ...(result.details.asyncDir ? { asyncDir: result.details.asyncDir } : {}),
        ...(lane ? { lane } : {}),
        ...(terminalOutcome ? { terminalOutcome } : {}),
        ...(resolvedAgents.length === 1 ? { agent: resolvedAgents[0] } : {}),
        ...(runId ? { runId } : {}),
        output,
        ...(!ok && !running ? { error: failureError } : {}),
        ...(detached ? { detached: true } : {}),
        ...(interrupted ? { interrupted: true } : {}),
        ...(stopped ? { stopped: true } : {}),
        ...(structured.length === 1 ? { structuredOutput: structured[0] } : structured.length > 1 ? { structuredOutput: structured } : {}),
        ...(requestedContext ? { requestedContext } : {}),
        ...(resolvedContext ? { resolvedContext } : {}),
        ...(outputReference ? { outputReference } : {}),
        ...(outputArtifactPath ? { outputArtifactPath } : {}),
        ...(acceptanceRecovery ? { recovery: acceptanceRecovery } : {}),
        ...(outputPathMapping ? { outputPathMapping } : {}),
        ...(externalAdapter ? { externalAdapter } : {}),
        resumability,
        continuation: { runIds: runId ? [runId] : [] },
        artifactPaths: [...artifactPaths],
        results: result.details.results,
    };
}
function workflowChildAccountingFields(child) {
    if (!child.results?.length)
        return {};
    const usage = sumResultsUsage(child.results);
    const sessionFile = child.results.find((result) => result.sessionFile)?.sessionFile;
    return {
        ...(usage.input !== 0 || usage.output !== 0 || usage.cacheRead !== 0 || usage.cacheWrite !== 0 || usage.cost !== 0 || usage.turns !== 0 ? { usage } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        ...(child.recovery ? { recovery: child.recovery } : {}),
    };
}
function workflowRunningChildrenSummary(children) {
    const running = children.filter((child) => child.state === "running");
    return running.length ? `${running.length} child ${running.length === 1 ? "run remains" : "runs remain"} running or uncollected: ${running.map((child) => `${child.key}=${child.runId}`).join(", ")}. These launch receipts contain no final child results.` : "";
}
function workflowResultChildren(children, status, includeFailureFields) {
    return withWorkflowRevivals(DIRS.async, status.runId, children).map((child) => {
        const sessionName = status.steps?.find((step) => step.workflowKey === child.key)?.sessionName;
        return { workflowKey: child.key, ...(child.agent ? { agent: child.agent } : {}), ...(child.runId ? { runId: child.runId } : {}), ...(child.revival ? { revival: formatWorkflowKeyRevival(child.revival) } : {}), ...(sessionName ? { sessionName } : {}), ...workflowChildAccountingFields(child), output: child.output, outputState: child.output.trim() || child.structuredOutput !== undefined ? "present" : "absent", structuredOutput: child.structuredOutput, ...(child.state === "running" ? { state: "running" } : { success: child.ok }), ...(child.asyncDir ? { asyncDir: child.asyncDir } : {}), ...(child.outputReference ? { outputReference: child.outputReference } : {}), ...(includeFailureFields && child.terminalOutcome ? { terminalOutcome: child.terminalOutcome } : {}), ...(child.outputPathMapping ? { outputPathMapping: child.outputPathMapping } : {}), ...(child.stopped ? { stopped: true } : {}), ...(child.interrupted ? { interrupted: true } : {}), ...(includeFailureFields && child.detached && status.state !== "complete" ? { detached: true } : {}), ...(child.outputArtifactPath || child.outputReference ? { artifactPaths: { outputPath: child.outputArtifactPath ?? child.outputReference } } : {}) };
    });
}
function workflowOutputPathMappingSummary(children) {
    const mappings = children.flatMap((child) => child.outputPathMapping
        ? [`'${child.key}': requested ${child.outputPathMapping.requestedPath} -> saved ${child.outputPathMapping.savedPath}`]
        : []);
    return mappings.length > 0 ? ` Output path mappings: ${mappings.join("; ")}.` : "";
}
function workflowDetailsResults(children) {
    return children.flatMap((child) => (child.results ?? []).map((result) => result.workflowKey ? result : { ...result, workflowKey: child.key }));
}
function workflowSteerReceipt(key, result) {
    const steering = result.details.steering;
    const error = result.content.map((part) => part.type === "text" ? part.text : "").filter(Boolean).join("\n") || undefined;
    if (!steering)
        return { key, state: "failed", ...(error ? { error } : {}) };
    const state = result.isError === true || steering.state === "failed" || steering.state === "partial"
        ? "failed"
        : steering.deliveryStatus === "delivered" ? "delivered" : "queued";
    return {
        key,
        state,
        requestId: steering.requestId,
        deliveryStatus: steering.deliveryStatus,
        targets: steering.targets.map((target) => ({ index: target.index, state: target.state, ...(target.reason ? { reason: target.reason } : {}) })),
        ...(state === "failed" && error ? { error } : {}),
    };
}
const CHILD_SESSION_NOT_RUNNING_YET = "Child session is not running yet.";
const MAX_WORKFLOW_RESUME_HINT_BYTES = 1024;
const MAX_WORKFLOW_CHILD_RUN_ID_BYTES = 256;
const WORKFLOW_RESUME_HINT_PARENT_STATES = new Set(["complete", "failed", "partial"]);
const WORKFLOW_STEP_STATES = new Set(["pending", "running", "complete", "completed", "failed", "partial", "paused", "stopped", "rejected"]);
function isSafeWorkflowChildRunId(value) {
    if (typeof value !== "string")
        return false;
    const runId = value.trim();
    return value === runId
        && Boolean(runId)
        && Buffer.byteLength(runId, "utf8") <= MAX_WORKFLOW_CHILD_RUN_ID_BYTES
        && path.basename(runId) === runId
        && path.win32.basename(runId) === runId
        && !/[\\/]/.test(runId)
        && !runId.includes("..")
        && !/[\u0000-\u001f\u007f]/.test(runId);
}
function isMissingWorkflowReceiptDiagnostic(error, workflowRunId) {
    return error instanceof Error
        && error.message.startsWith(`Workflow receipt '${workflowRunId}' is not available because the workflow may still be active or terminal receipt writing failed.`);
}
function missingWorkflowReceiptResumeHint(reference, state) {
    try {
        if (!state.currentSessionId)
            return undefined;
        const workflowRunId = reference.workflowRunId.trim();
        const workflowStatus = readStatus(path.join(DIRS.async, workflowRunId));
        if (!workflowStatus
            || workflowStatus.runId !== workflowRunId
            || workflowStatus.mode !== "workflow"
            || workflowStatus.sessionId !== state.currentSessionId
            || typeof workflowStatus.startedAt !== "number"
            || !Number.isFinite(workflowStatus.startedAt)
            || !WORKFLOW_RESUME_HINT_PARENT_STATES.has(workflowStatus.state)
            || !Array.isArray(workflowStatus.steps)
            || workflowStatus.steps.some((step) => {
                if (!step || typeof step !== "object" || Array.isArray(step))
                    return true;
                const record = step;
                return typeof record.agent !== "string"
                    || typeof record.status !== "string"
                    || !WORKFLOW_STEP_STATES.has(record.status)
                    || (record.workflowKey !== undefined && typeof record.workflowKey !== "string")
                    || (record.runId !== undefined && typeof record.runId !== "string");
            }))
            return undefined;
        const matchingSteps = workflowStatus.steps.filter((step) => step.workflowKey === reference.key);
        if (matchingSteps.length !== 1)
            return undefined;
        const childRunId = matchingSteps[0]?.runId;
        if (!isSafeWorkflowChildRunId(childRunId))
            return undefined;
        const workflowChildren = parseWorkflowChildSummary(workflowStatus.workflowChildren);
        if (workflowChildren) {
            if (workflowChildren.workflowRunId !== workflowRunId)
                return undefined;
            const matchingChildren = workflowChildren.children.filter((child) => child.childId === reference.key);
            if (matchingChildren.length > 1 || (workflowChildren.inventoryComplete && matchingChildren.length !== 1))
                return undefined;
            if (matchingChildren.length === 1 && matchingChildren[0]?.runId !== childRunId)
                return undefined;
        }
        const target = resolveResumeTarget({ id: childRunId }, state, { asyncRequireSessionFile: true, exactOnly: true });
        if (target.kind !== "revive")
            return undefined;
        const hint = `Direct resumable child for workflow key '${reference.key}': subagent({ action: "resume", id: ${JSON.stringify(childRunId)}, message: "..." })`;
        return Buffer.byteLength(hint, "utf8") <= MAX_WORKFLOW_RESUME_HINT_BYTES ? hint : undefined;
    }
    catch {
        return undefined;
    }
}
function resolveWorkflowResume(reference, deps, parentSessionFile, index) {
    const state = deps.state;
    if (typeof reference === "string") {
        const target = resolveRequestedResumeTarget({ id: reference.trim(), ...(index !== undefined ? { index } : {}) }, deps, parentSessionFile);
        // Live routing stays with action=resume and does not claim retained lineage.
        if (target.kind !== "revive")
            return reference.trim();
        const runId = target.runId;
        const status = target.source === "async" && target.asyncDir ? readStatus(target.asyncDir) : undefined;
        if (status?.runId === runId && status.parentWorkflowRunId && status.workflowKey) {
            // Only follow the validated child's recorded owner; never search other workflows.
            const receiptPath = workflowReceiptPath(DIRS.async, status.parentWorkflowRunId);
            try {
                fs.statSync(receiptPath);
            }
            catch (error) {
                if (error.code === "ENOENT")
                    return { runId, runIds: [runId] };
                throw error;
            }
            const entry = readWorkflowReceipt(DIRS.async, status.parentWorkflowRunId).entries[status.workflowKey];
            if (entry?.latestRunId === runId)
                return { runId, runIds: entry.continuation.runIds };
        }
        return { runId, runIds: [runId] };
    }
    try {
        const entry = resolveWorkflowReceiptResumeEntry({
            reference,
            asyncDirRoot: DIRS.async,
            assertResumable(runId) {
                const target = resolveResumeTarget({ id: runId }, state, { asyncRequireSessionFile: true, exactOnly: true });
                if (target.kind !== "revive")
                    throw new Error(`Workflow receipt child '${reference.key}' latest run '${runId}' is still running.`);
            },
        });
        return { runId: entry.latestRunId, runIds: entry.continuation.runIds };
    }
    catch (error) {
        const workflowRunId = reference.workflowRunId.trim();
        if (isMissingWorkflowReceiptDiagnostic(error, workflowRunId)) {
            const hint = missingWorkflowReceiptResumeHint(reference, state);
            if (hint)
                throw new Error(`${error.message} ${hint}`, { cause: error });
        }
        throw error;
    }
}
function terminalWorkflowReceipt(workflowRunId, state, children, workflowChildren, terminalOutcome, hostSteps, resource, argsDigest) {
    return buildWorkflowReceipt({ workflowRunId, state, children: withWorkflowRevivals(DIRS.async, workflowRunId, children), workflowChildren, terminalOutcome, hostSteps, resource, ...(argsDigest ? { argsDigest } : {}) });
}
function workflowFailureTerminalOutcome(error, _children, usageBudget) {
    if (usageBudget?.exhausted)
        return { state: "partial", reason: "budget_exhausted" };
    return error instanceof WorkflowScriptError && error.errorKind === "timeout" ? { state: "partial", reason: "timeout" } : undefined;
}
function workflowFailureMessage(error, workflowRunId, children) {
    const text = error instanceof Error ? error.message : String(error);
    const validationPrefix = "workflowScript validation failed before child launch; no children launched.";
    if (children.length === 0 && text.includes(validationPrefix)) {
        return `Workflow '${workflowRunId}' validation failed before child launch; no children launched.${text.slice(text.indexOf(validationPrefix) + validationPrefix.length)}`;
    }
    return [text, workflowRunningChildrenSummary(children)].filter(Boolean).join(" ");
}
export async function steerWorkflowChildByKey(input) {
    const asyncDirRoot = input.asyncDirRoot ?? DIRS.async;
    const ackTimeoutMs = input.options.ackTimeoutMs ?? 3_000;
    const deadline = Date.now() + ackTimeoutMs;
    while (true) {
        const control = [...input.state.foregroundControls.values()].find((candidate) => candidate.parentWorkflowRunId === input.workflowRunId
            && candidate.workflowKey === input.key
            && (candidate.activeChildren?.size ?? 0) > 0);
        if (control) {
            const result = await steerWorkflowForegroundTarget({
                target: { control, workflowRunId: input.workflowRunId, sourceRunId: control.runId },
                message: input.message,
                mode: input.options.mode,
                index: input.options.index,
            });
            // The control registers before its child session exists; keep polling until the steer can route.
            if (!result.details.steering?.targets.some((target) => target.reason === CHILD_SESSION_NOT_RUNNING_YET) || Date.now() >= deadline)
                return workflowSteerReceipt(input.key, result);
        }
        const workflowStatus = readStatus(path.join(asyncDirRoot, input.workflowRunId));
        const step = workflowStatus?.steps?.find((candidate) => candidate.workflowKey === input.key);
        const childRunId = step?.runId ?? input.resolveRunId?.();
        if (childRunId) {
            const asyncDir = path.join(asyncDirRoot, childRunId);
            const childStatus = reconcileAsyncRun(asyncDir).status;
            if (childStatus && childStatus.state !== "running" && childStatus.state !== "queued" && (input.options.mode !== "follow_up" || !canQueueRetainedAsyncFollowUp(childStatus, input.options.index))) {
                return { key: input.key, state: "missed", error: `Workflow child '${input.key}' is ${childStatus.state}.` };
            }
            if (childStatus) {
                const unsupported = externalRunnerControlError(asyncDir, "steer");
                if (unsupported)
                    return workflowSteerReceipt(input.key, unsupported);
                const result = await steerAsyncRun({
                    state: input.state,
                    runId: childRunId,
                    message: input.message,
                    mode: input.options.mode,
                    index: input.options.index,
                    ackTimeoutMs: Math.max(1, deadline - Date.now()),
                    location: { asyncDir },
                    signal: input.signal,
                });
                return workflowSteerReceipt(input.key, result);
            }
        }
        if (step && step.status !== "running" && step.status !== "pending") {
            return { key: input.key, state: "missed", error: `Workflow child '${input.key}' is ${step.status}.` };
        }
        if (workflowStatus && workflowStatus.state !== "running" && workflowStatus.state !== "queued") {
            return { key: input.key, state: "missed", error: `Workflow '${input.workflowRunId}' is ${workflowStatus.state}.` };
        }
        if (input.signal?.aborted || Date.now() >= deadline) {
            return { key: input.key, state: "missed", error: `Workflow child '${input.key}' had no live steering route.` };
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(1, deadline - Date.now()))));
    }
}
export async function preflightWorkflowWorktrees(input) {
    const sources = new Map();
    for (const { key, params } of input.calls) {
        // The workflow validates retained IDs/receipt references before admission; resolution follows it.
        if (params.resume !== undefined)
            continue;
        const effective = prepareWorkflowLaunchParams(input.workflowDefaults, params, "preflight", key);
        if ((effective.worktree ?? input.defaultWorktree) !== true)
            continue;
        // Match recursive execute's resolution, including relative default/child cwd.
        const cwd = resolveRequestedCwd(input.ctxCwd, effective.cwd);
        const keys = sources.get(cwd) ?? [];
        keys.push(key);
        sources.set(cwd, keys);
    }
    for (const [cwd, keys] of sources) {
        try {
            await preflightWorktreeSource(cwd, { signal: input.signal, deadlineAt: input.deadlineAt });
        }
        catch (error) {
            throw new Error(`Worktree admission failed for ${keys.map((key) => `'${key}'`).join(", ")} at ${cwd}: ${error instanceof Error ? error.message : String(error)} Select the correct cwd or arrange an operator-approved commit/stash.`, { cause: error });
        }
    }
    input.signal.throwIfAborted();
}
export function prepareWorkflowLaunchParams(workflowDefaults, childParams, parentWorkflowRunId, workflowKey, options = {}) {
    const { globalConcurrencyLimit: _globalConcurrencyLimit, maxSubagentSpawnsPerRun: _maxSubagentSpawnsPerRun, ...workflowDefaultsWithoutCapacity } = workflowDefaults;
    const { globalConcurrencyLimit: _childGlobalConcurrencyLimit, maxSubagentSpawnsPerRun: _childMaxSubagentSpawnsPerRun, ...childParamsWithoutCapacity } = childParams;
    workflowDefaults = workflowDefaultsWithoutCapacity;
    childParams = childParamsWithoutCapacity;
    const capabilityCeiling = intersectSubagentCapabilityCeilings(workflowDefaults.capabilityCeiling, options.capabilityCeiling);
    const lane = normalizeWorkflowLaneMetadata(Object.hasOwn(childParams, "lane") ? childParams.lane : workflowDefaults.lane, `workflow child '${workflowKey}'.lane`);
    assertWorkflowLaneKey(lane, workflowKey, `workflow child '${workflowKey}'.lane`);
    const parentTimeoutMs = options.parentDeadlineAt === undefined
        || childParams.timeoutMs !== undefined
        || childParams.maxRuntimeMs !== undefined
        || workflowDefaults.timeoutMs !== undefined
        || workflowDefaults.maxRuntimeMs !== undefined
        ? undefined
        : Math.max(1, options.parentDeadlineAt - Date.now());
    if (typeof childParams.resume === "string") {
        if (childParams.extensionBindings !== undefined || workflowDefaults.extensionBindings !== undefined) {
            throw new Error("extensionBindings is not supported with retained resume; resume uses the original retained child binding.");
        }
        if (childParams.gate !== undefined || workflowDefaults.gate !== undefined) {
            throw new Error("gate is not supported with retained resume; resume uses the retained child contract.");
        }
        const timeoutMs = childParams.timeoutMs ?? childParams.maxRuntimeMs ?? workflowDefaults.timeoutMs ?? workflowDefaults.maxRuntimeMs;
        const toolBudget = childParams.toolBudget ?? workflowDefaults.toolBudget;
        const intercomBridge = childParams.intercomBridge ?? workflowDefaults.intercomBridge;
        const worktree = childParams.worktree ?? workflowDefaults.worktree;
        const baseRef = Object.hasOwn(childParams, "baseRef") ? childParams.baseRef : undefined;
        const outputSchema = Object.hasOwn(childParams, "outputSchema") ? childParams.outputSchema : workflowDefaults.outputSchema;
        if (outputSchema !== undefined && outputSchema !== false)
            assertJsonSchemaObject(outputSchema, "outputSchema");
        const agentContract = Object.hasOwn(childParams, "agentContract") ? childParams.agentContract : workflowDefaults.agentContract;
        if (agentContract !== undefined && !isAgentContract(agentContract))
            throw new Error("agentContract must be { version: 1 }.");
        const acceptance = Object.hasOwn(childParams, "acceptance") ? childParams.acceptance : workflowDefaults.acceptance;
        const output = Object.hasOwn(childParams, "output") ? childParams.output : workflowDefaults.output;
        if (output !== undefined && typeof output !== "string" && typeof output !== "boolean")
            throw new Error("output must be a path string or boolean.");
        const outputMode = Object.hasOwn(childParams, "outputMode") ? childParams.outputMode : workflowDefaults.outputMode;
        if (outputMode !== undefined && outputMode !== "inline" && outputMode !== "file-only")
            throw new Error("outputMode must be 'inline' or 'file-only'.");
        const control = mergeWorkflowControlOverrides(workflowDefaults.control, childParams.control);
        return {
            action: "resume",
            id: childParams.resume.trim(),
            ...(typeof childParams.index === "number" && Number.isInteger(childParams.index) ? { index: childParams.index } : {}),
            message: typeof childParams.task === "string" ? childParams.task.trim() : "",
            workflowParentRunId: parentWorkflowRunId,
            workflowKey,
            ...(options.outputClaimPath ? { workflowOutputClaimPath: options.outputClaimPath } : {}),
            ...(lane ? { lane } : {}),
            ...(worktree !== undefined ? { worktree: worktree } : {}),
            ...(baseRef !== undefined ? { baseRef: baseRef } : {}),
            ...(outputSchema !== undefined ? { outputSchema } : {}),
            ...(agentContract !== undefined ? { agentContract: agentContract } : {}),
            ...(acceptance !== undefined ? { acceptance: acceptance } : {}),
            ...(output !== undefined ? { output: output } : {}),
            ...(outputMode !== undefined ? { outputMode: outputMode } : {}),
            ...(options.runFanoutBudget ? { runFanoutBudget: { ...options.runFanoutBudget, parentPath: `${options.runFanoutBudget.parentPath ? `${options.runFanoutBudget.parentPath}/` : ""}workflow[${workflowKey}]` } } : {}),
            ...(options.missionDetached ? { mission: false } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs } : {}),
            ...(toolBudget !== undefined ? { toolBudget: toolBudget } : {}),
            ...(control !== undefined ? { control } : {}),
            ...(intercomBridge !== undefined ? { intercomBridge: intercomBridge } : {}),
            ...(capabilityCeiling ? { capabilityCeiling } : {}),
        };
    }
    const control = mergeWorkflowControlOverrides(workflowDefaults.control, childParams.control);
    const asyncOmitted = childParams.async === undefined && workflowDefaults.async === undefined;
    const launchParams = {
        ...workflowDefaults,
        ...(options.externalAsyncRequired === true && asyncOmitted ? { async: true } : {}),
        ...childParams,
        ...(control !== undefined ? { control } : {}),
        ...(asyncOmitted ? { workflowAwaitAsync: true } : {}),
        ...(options.missionDetached ? { mission: false } : {}),
        workflowParentRunId: parentWorkflowRunId,
        workflowKey,
        ...(options.outputClaimPath ? { workflowOutputClaimPath: options.outputClaimPath } : {}),
        ...(options.awaitDetachedChild ? { workflowAwaitDetached: true } : {}),
        ...(lane ? { lane } : {}),
        ...(parentTimeoutMs !== undefined ? { workflowParentDeadlineAt: options.parentDeadlineAt } : {}),
        ...(options.runFanoutBudget ? { runFanoutBudget: { ...options.runFanoutBudget, parentPath: `${options.runFanoutBudget.parentPath ? `${options.runFanoutBudget.parentPath}/` : ""}workflow[${workflowKey}]` } } : {}),
        ...(options.suppressRoutineResultIntercom ? { suppressRoutineResultIntercom: true } : {}),
        ...(capabilityCeiling ? { capabilityCeiling } : {}),
    };
    if (launchParams.extensionBindings !== undefined)
        launchParams.extensionBindings = normalizeExtensionBindings(launchParams.extensionBindings).value;
    const normalizedGate = normalizeGateParams(launchParams);
    if (!normalizedGate.ok)
        throw new Error(normalizedGate.error);
    return normalizedGate.params;
}
function mergeWorkflowControlOverrides(workflowControl, childControl) {
    if (childControl === undefined)
        return workflowControl;
    if (workflowControl === undefined)
        return childControl;
    return { ...workflowControl, ...childControl };
}
export function resolveRevivalControlConfig(input) {
    if (input.requestedControl === undefined)
        return input.recoveryControlConfig ?? resolveControlConfig(input.globalConfig, undefined);
    return resolveControlConfig(input.recoveryControlConfig ?? input.globalConfig, input.requestedControl);
}
function normalizeGateParams(params) {
    if (params.gate !== undefined && params.action === "resume") {
        return { ok: false, error: "gate is not supported with action='resume'; resume uses the retained child contract." };
    }
    const normalized = normalizeGateAcceptance(params.gate, params.acceptance);
    if (!normalized.ok)
        return { ok: false, error: normalized.error };
    if (params.gate === undefined)
        return { ok: true, params };
    const { gate: _gate, ...rest } = params;
    return { ok: true, params: { ...rest, ...(normalized.acceptance !== undefined ? { acceptance: normalized.acceptance } : {}) } };
}
function describeTypedVerifyOutputSchemaConflict(effective, requested) {
    if (!acceptanceHasTypedVerify(effective.acceptance))
        return undefined;
    if (effective.outputSchema === undefined || effective.outputSchema === false)
        return undefined;
    const agent = effective.agent ?? "?";
    const schemaSource = requested.outputSchema !== undefined && requested.outputSchema !== false ? "outputSchema" : `agent '${agent}' outputSchema`;
    const verifySource = requested.gate !== undefined ? "gate.output" : requested.acceptance !== undefined ? "acceptance.verify" : `agent '${agent}' defaultAcceptance`;
    return `${verifySource}: ${TYPED_VERIFY_OUTPUT_SCHEMA_CONFLICT.replace("with outputSchema", `with ${schemaSource}`)}`;
}
function formatWorkflowValue(value) {
    if (value === undefined)
        return "(undefined)";
    if (typeof value === "string")
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
function buildWorkflowLaneGraph(runId, lanes, existing) {
    const plannedIds = new Set(lanes.flatMap((lane) => lane.stages.map((stage) => stage.generatedKey)));
    const previousById = new Map((existing?.nodes ?? []).map((node) => [node.id, node]));
    const nodes = [];
    const phases = [];
    let flatIndex = 0;
    for (const lane of lanes) {
        const nodeIds = [];
        for (const [stageIndex, stage] of lane.stages.entries()) {
            const previous = previousById.get(stage.generatedKey);
            const outputName = stage.outputName || previous?.outputName;
            const structured = stage.structured ?? previous?.structured;
            const node = {
                id: stage.generatedKey,
                kind: "step",
                agent: stage.agent ?? previous?.agent,
                phase: stage.phase ?? previous?.phase,
                label: stage.label ?? stage.key,
                status: previous?.status ?? (stageIndex === 0 ? "running" : "pending"),
                flatIndex,
                stepIndex: flatIndex,
                ...(outputName ? { outputName } : {}),
                ...(structured !== undefined ? { structured } : {}),
                ...(previous?.acceptanceStatus ? { acceptanceStatus: previous.acceptanceStatus } : {}),
                ...(previous?.error ? { error: previous.error } : {}),
            };
            nodes.push(node);
            nodeIds.push(node.id);
            flatIndex++;
        }
        if (nodeIds.length > 0)
            phases.push({ title: lane.key, nodeIds });
    }
    for (const node of existing?.nodes ?? []) {
        if (!plannedIds.has(node.id))
            nodes.push(node);
    }
    for (const phase of existing?.phases ?? []) {
        const retainedNodeIds = phase.nodeIds.filter((nodeId) => !plannedIds.has(nodeId));
        if (retainedNodeIds.length === 0)
            continue;
        const currentPhase = phases.find((candidate) => candidate.title === phase.title);
        if (currentPhase)
            currentPhase.nodeIds.push(...retainedNodeIds);
        else
            phases.push({ title: phase.title, nodeIds: retainedNodeIds });
    }
    const currentNodeId = nodes.find((node) => node.status === "running")?.id ?? existing?.currentNodeId;
    return { runId, mode: "workflow", phases, nodes, ...(currentNodeId ? { currentNodeId } : {}) };
}
function workflowLaneTraceStatus(state) {
    switch (state) {
        case "started":
            return "running";
        case "reused":
            return undefined;
        case "completed":
            return "completed";
        case "failed":
            return "failed";
        case "detached":
            return "detached";
        case "stopped":
            return "stopped";
        default:
            return undefined;
    }
}
function applyWorkflowLaneTrace(graph, trace) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    for (const entry of trace) {
        if (entry.operation !== "run")
            continue;
        const node = nodesById.get(entry.key);
        if (!node)
            continue;
        const status = workflowLaneTraceStatus(entry.state);
        if (status)
            node.status = status;
        if (entry.agent)
            node.agent = entry.agent;
        if (entry.phase && (entry.phase !== "auto-resume" || node.phase === undefined))
            node.phase = entry.phase;
        if (entry.label)
            node.label = entry.label;
        if (entry.error)
            node.error = entry.error;
        else if (status === "completed" || status === "running")
            delete node.error;
    }
    const currentNodeId = graph.nodes.find((node) => node.status === "running")?.id;
    if (currentNodeId)
        graph.currentNodeId = currentNodeId;
    else
        delete graph.currentNodeId;
}
function workflowProgressUpdate(runId, chatProgress, workflow, workflowChildren, preflight) {
    // chatProgress controls the TUI projection, not transport-level progress.
    return {
        content: [{ type: "text", text: "Workflow running." }],
        details: { mode: "workflow", runId, results: [], workflow, ...(preflight ? { preflight } : {}), ...(workflowChildren ? { workflowChildren } : {}), chatProgress },
    };
}
function createScheduledOwnerState(source, ownerSessionId, ctx) {
    const ownerSpawns = source.subagentSpawns?.sessionId === ownerSessionId
        ? {
            ...source.subagentSpawns,
            grantHistory: [...(source.subagentSpawns.grantHistory ?? [])],
        }
        : undefined;
    const ownerParentModel = source.currentSessionId === ownerSessionId ? source.lastParentModel : undefined;
    return {
        ...source,
        baseCwd: ctx.cwd,
        currentSessionId: ownerSessionId,
        lastParentModel: ownerParentModel,
        parentSessionFile: ctx.sessionManager.getSessionFile() ?? null,
        subagentInProgress: false,
        ...(ownerSpawns ? { subagentSpawns: ownerSpawns } : { subagentSpawns: undefined }),
        herdrProjectPanes: new Map(),
        asyncJobs: new Map(),
        fleetJobs: new Map(),
        foregroundRuns: new Map(),
        foregroundControls: new Map(),
        lastForegroundControlId: null,
        cleanupTimers: new Map(),
        lastUiContext: null,
        poller: null,
        completionSeen: new Map(),
        watcher: null,
        watcherRestartTimer: null,
        waitSubscriptions: new Map(),
        workflowControllers: new Map(),
        workflowChildStops: new Map(),
    };
}
export function createSubagentExecutor(deps) {
    const delegatedThinkingOverrides = new WeakMap();
    const delegatedZeroToolBudgets = new WeakSet();
    const delegatedExecutions = new WeakSet();
    const publicExecutions = new WeakSet();
    const workflowResourcePermits = new WeakMap();
    const workflowPermitContexts = new WeakMap();
    const warnedArtifactPackageDirs = new Set();
    const scheduledOwnerExecutors = new Map();
    const disabledFeatures = resolveDisabledFeatureSurface(deps.config);
    const disabledFeatureResult = (params) => {
        const error = disabledFeatureUseError(params, disabledFeatures);
        if (!error)
            return undefined;
        return { content: [{ type: "text", text: error }], isError: true, details: { mode: params.action === undefined ? inferExecutionMode(params) : "management", results: [] } };
    };
    const admitEnabledWorkflowChildren = (calls) => {
        for (const call of calls) {
            const error = disabledFeatureUseError(call.params, disabledFeatures, `workflow child '${call.key}'`);
            if (error)
                throw new Error(error);
        }
    };
    const execute = async (_id, params, signal, onUpdate, ctx, preserveActiveSession = false, parentModelOverride) => {
        const workflowLaunchObserver = workflowLaunchObservers.get(params);
        const inheritedUsageBudget = workflowOwnedUsageBudgets.get(params);
        const delegatedThinkingOverride = delegatedThinkingOverrides.get(params);
        const allowZeroToolBudget = delegatedZeroToolBudgets.has(params);
        const delegatedExecution = delegatedExecutions.has(params);
        const publicExecution = publicExecutions.has(params);
        const workflowResourcePermit = workflowResourcePermits.get(params);
        const workflowPermitContext = workflowPermitContexts.get(params);
        const delegatedWorkflowPermit = workflowPermitContext && "root" in workflowPermitContext ? workflowPermitContext.root : undefined;
        const workflowChildPermitLaunch = workflowPermitContext && "child" in workflowPermitContext ? workflowPermitContext.child : undefined;
        if (!preserveActiveSession)
            deps.state.baseCwd = ctx.cwd;
        deps.state.foregroundRuns ??= new Map();
        deps.state.foregroundControls ??= new Map();
        deps.state.lastForegroundControlId ??= null;
        const normalizedGate = normalizeGateParams(params);
        if (!normalizedGate.ok)
            return buildRequestedModeError(params, normalizedGate.error);
        let requestParams = normalizedGate.params;
        const capacityOverrideError = validateWorkflowCapacityOverrides(requestParams);
        if (capacityOverrideError)
            return buildRequestedModeError(requestParams, capacityOverrideError);
        let workflowPreflight;
        // Only workflow requests read the session here; other actions (for example doctor) must not.
        const resolveWorkflowParentModel = () => parentModelOverride !== undefined
            ? parentModelOverride
            : (() => {
                const currentParentModel = normalizeParentModel(ctx.model);
                return (preserveActiveSession
                    ? currentParentModel
                    : rememberParentModel(deps.state, resolveCurrentSessionId(ctx.sessionManager), currentParentModel)) ?? null;
            })();
        try {
            if (requestParams.preflight !== undefined && requestParams.workflowScript === undefined) {
                throw new Error("preflight requires workflow: true or a workflow script path.");
            }
            workflowPreflight = normalizeWorkflowPreflight(requestParams.preflight);
            if (workflowPreflight)
                requestParams = { ...requestParams, preflight: workflowPreflight };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (requestParams.action?.trim() === "validate") {
                const validation = validateWorkflowScript(requestParams.workflowScript ?? "", workflowValidationOptions(deps, requestParams, ctx.cwd, () => resolveWorkflowParentModel()?.provider));
                const invalidValidation = { ...validation, ok: false, errors: [...validation.errors, { message }] };
                return {
                    content: [{ type: "text", text: JSON.stringify(invalidValidation) }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            return buildRequestedModeError(requestParams, message);
        }
        if (requestParams.action?.trim() === "validate") {
            const validation = validateWorkflowScript(requestParams.workflowScript ?? "", workflowValidationOptions(deps, requestParams, ctx.cwd, () => resolveWorkflowParentModel()?.provider));
            return buildWorkflowValidationResult(validation, "management", workflowPreflight);
        }
        const normalizedAction = typeof requestParams.action === "string" ? requestParams.action.trim() : requestParams.action;
        if (normalizedAction === "resume" && requestParams.extensionBindings !== undefined)
            return buildRequestedModeError(requestParams, "extensionBindings is not supported with action='resume'; resume uses the original retained child binding.");
        let workflowResource;
        if (workflowResourcePermit) {
            if (typeof requestParams.workflowScript !== "string")
                return buildRequestedModeError(requestParams, "Resolved workflow resource is missing its workflow script.");
            const consumed = consumeWorkflowResourcePermit(workflowResourcePermit, requestParams.workflowScript);
            if (typeof consumed === "string")
                return buildRequestedModeError(requestParams, consumed);
            workflowResource = { permit: workflowResourcePermit, ...consumed };
        }
        if (requestParams.workflowScript !== undefined && normalizedAction === undefined) {
            const workflowArgsEvidence = requestParams.args === undefined ? undefined : { args: requestParams.args, argsDigest: stableJsonDigest(requestParams.args) };
            const workflowArgs = workflowArgsEvidence?.args;
            const workflowArgsDigest = workflowArgsEvidence?.argsDigest;
            const workflowParentModel = resolveWorkflowParentModel();
            const workflowValidation = validateWorkflowScript(requestParams.workflowScript, workflowValidationOptions(deps, requestParams, ctx.cwd, () => workflowParentModel?.provider));
            if (!workflowValidation.ok && publicExecution)
                return buildWorkflowValidationResult(workflowValidation, "workflow", workflowPreflight);
            const launchBlockingErrors = workflowValidation.errors.filter((error) => error.kind === "spawn-budget" || error.kind === "agent");
            if (launchBlockingErrors.length > 0) {
                return buildRequestedModeError(requestParams, `Workflow '${_id}' validation failed before child launch; no children launched. ${launchBlockingErrors.map((error) => error.message).join(" ")}`);
            }
            // A package chain's per-step stop check defeats static launch counting; runtime fan-out enforcement still applies.
            const structuredResource = workflowResource?.provenance.name === "chain" || workflowResource?.provenance.name === "tasks";
            for (const warning of workflowValidation.warnings ?? []) {
                if (!(structuredResource && warning.kind === "dynamic-spawn-count"))
                    console.warn(`[pi-subagents] ${warning.message}`);
            }
            const acceptanceErrors = validateAcceptanceInput(requestParams.acceptance);
            if (acceptanceErrors.length > 0)
                return buildRequestedModeError(requestParams, acceptanceErrors.join(" "));
            const foregroundWorkflowRunId = encodeIndexSegment(_id);
            if (delegatedWorkflowPermit) {
                const permitError = validateWorkflowChildPermitRoot(delegatedWorkflowPermit, foregroundWorkflowRunId);
                if (permitError)
                    return buildRequestedModeError(requestParams, permitError);
                if (requestParams.async !== false)
                    return buildRequestedModeError(requestParams, "Workflow child permit supports foreground workflow roots only; set async:false.");
            }
            if (requestParams.extensionBindings !== undefined) {
                try {
                    requestParams.extensionBindings = normalizeExtensionBindings(requestParams.extensionBindings).value;
                }
                catch (error) {
                    return buildRequestedModeError(requestParams, error instanceof Error ? error.message : String(error));
                }
            }
            const parentCwd = ctx.cwd;
            for (const [name, value] of [["timeoutMs", requestParams.timeoutMs], ["maxRuntimeMs", requestParams.maxRuntimeMs]]) {
                if (value === undefined)
                    continue;
                const overflowError = timerDelayOverflowError(name, value);
                if (overflowError)
                    return buildRequestedModeError(requestParams, overflowError);
            }
            const timeout = requestParams.timeoutMs ?? requestParams.maxRuntimeMs ?? (requestParams.async === false ? resolveConfigDefaultTimeoutMs(deps.config.timeoutMs) ?? DEFAULT_FOREGROUND_TIMEOUT_MS : undefined);
            const workflowUsageBudget = validateUsageBudgetConfig(requestParams.usageBudget ?? deps.config.usageBudget, requestParams.usageBudget ? "usageBudget" : "config.usageBudget");
            if (workflowUsageBudget.error)
                return buildRequestedModeError(requestParams, workflowUsageBudget.error);
            const workflowCwd = resolveRequestedCwd(parentCwd, requestParams.cwd);
            const discoverWorkflowAgents = (cwd, scope) => deps.discoverAgents(cwd, scope, workflowParentModel?.provider);
            const workflowAgents = discoverWorkflowAgents(workflowCwd, resolveExecutionAgentScope(requestParams.agentScope)).agents;
            const workflowArtifactConfig = omitUndefinedProperties({
                ...DEFAULT_ARTIFACT_CONFIG,
                enabled: requestParams.artifacts !== false,
                dir: deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
            });
            const workflowArtifactsDir = getArtifactsDir(ctx.sessionManager.getSessionFile() ?? null, workflowCwd, workflowArtifactConfig.dir);
            if (workflowArtifactConfig.dir === "project" && !warnedArtifactPackageDirs.has(workflowCwd)) {
                warnedArtifactPackageDirs.add(workflowCwd);
                const warning = getProjectArtifactPackagingWarning(workflowCwd);
                if (warning)
                    console.warn(`[pi-subagents] ${warning}`);
            }
            const chatProgressResult = resolveWorkflowChatProgress({ requested: requestParams.chatProgress, parentCwd, workflowCwd, background: requestParams.async !== false });
            if (chatProgressResult.error)
                return { content: [{ type: "text", text: chatProgressResult.error }], isError: true, details: { mode: "workflow", results: [] } };
            const chatProgress = chatProgressResult.projection;
            const explicitMission = requestParams.missionId !== undefined || requestParams.mission !== undefined;
            const autoMission = !explicitMission;
            const workflowPreview = autoMission ? previewSimpleWorkflowRun(requestParams.workflowScript) : undefined;
            const previewAgent = workflowPreview?.agent?.trim() || undefined;
            const scriptFirstLine = requestParams.workflowScript.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "Workflow";
            const boundedScriptPreview = scriptFirstLine.length > 100 ? `${scriptFirstLine.slice(0, 97)}...` : scriptFirstLine;
            const derivedObjective = previewAgent ? `Workflow: ${previewAgent}` : boundedScriptPreview;
            const workflowDepth = checkSubagentDepth(deps.config.maxSubagentDepth, deps.childRuntime).depth;
            const asyncWorkflow = requestParams.async !== false;
            const topLevelAsyncWorkflow = asyncWorkflow
                && workflowDepth === 0
                && !inheritedNestedRoute(deps)
                && !requestParams.workflowParentRunId;
            const workflowRunId = asyncWorkflow ? randomUUID() : undefined;
            let workflowCapacity;
            if (workflowRunId && topLevelAsyncWorkflow) {
                const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                try {
                    workflowCapacity = acquireActiveAsyncCapacity({
                        sessionId: currentSessionId,
                        limit: resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession),
                        runId: workflowRunId,
                        kind: "workflow",
                        asyncDir: path.join(DIRS.async, workflowRunId),
                    }, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) });
                }
                catch (error) {
                    if (error instanceof ActiveAsyncCapacityError) {
                        deps.state.activeAsyncCapacity = error.snapshot;
                        return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: "workflow", results: [], activeAsyncCapacity: error.snapshot } };
                    }
                    throw error;
                }
            }
            let workflowFanoutBudget;
            try {
                workflowFanoutBudget = requestParams.runFanoutBudget
                    ?? inheritedRunFanoutBudget(deps)
                    ?? createRunFanoutBudget(_id, requestParams.maxSubagentSpawnsPerRun ?? resolveMaxSubagentSpawnsPerRun(deps.config.maxSubagentSpawnsPerRun));
            }
            catch (error) {
                workflowCapacity?.rollback();
                return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "workflow", results: [] } };
            }
            let missionBinding;
            let missionWarning;
            try {
                missionBinding = prepareMissionLaunch({
                    params: autoMission ? { ...requestParams, task: derivedObjective } : requestParams,
                    projectRoot: workflowCwd,
                    ...(deps.config.missions ? { config: deps.config.missions } : {}),
                    ownerSessionId: resolveCurrentSessionId(ctx.sessionManager),
                });
            }
            catch (error) {
                if (explicitMission) {
                    workflowCapacity?.rollback();
                    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "workflow", results: [] } };
                }
                missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
            }
            const detachWorkflowChildMissions = autoMission || missionBinding !== undefined || requestParams.mission === false;
            const workflowState = missionBinding ? createMissionWorkflowState(missionBinding.location, missionBinding.missionId) : undefined;
            const attachWorkflowMission = (result) => {
                if (!missionBinding)
                    return missionWarning ? { ...result, details: { ...result.details, missionWarning } } : result;
                try {
                    return attachMissionToLaunchResult({ binding: missionBinding, result });
                }
                catch (error) {
                    const warning = `Mission tracking unavailable after launch: ${error instanceof Error ? error.message : String(error)}`;
                    return explicitMission
                        ? { ...result, isError: true, content: [...result.content, { type: "text", text: warning }], details: { ...result.details, missionWarning: warning } }
                        : { ...result, details: { ...result.details, missionWarning: warning } };
                }
            };
            if (workflowRunId) {
                const toolCallId = _id;
                const workflowSessionRoot = requestParams.sessionDir
                    ? path.resolve(deps.expandTilde(requestParams.sessionDir))
                    : trustedSessionRootsForStatus(ctx, deps)[0];
                const asyncDir = path.join(DIRS.async, workflowRunId);
                const resultPath = resultFilePath(DIRS.results, workflowRunId);
                const statusPath = path.join(asyncDir, "status.json");
                const eventsPath = path.join(asyncDir, "events.jsonl");
                const startedAt = Date.now();
                const currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                const workflowCapabilityCeiling = intersectSubagentCapabilityCeilings(requestParams.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(currentSessionId));
                const completionOwnerId = deps.state.completionOwnerId ?? currentCompletionOwnerId();
                deps.state.completionOwnerId = completionOwnerId;
                const workflowScriptSourceDigest = workflowScriptDigest(requestParams.workflowScript);
                const workflowReuseSource = findWorkflowReuseSource(DIRS.async, currentSessionId, workflowScriptSourceDigest, workflowArgsDigest);
                const workflowRunEvidence = { ...workflowArgsEvidence, scriptDigest: workflowScriptSourceDigest };
                if (workflowReuseSource)
                    workflowRunEvidence.reusedFrom = workflowReuseSource.runId;
                const workflowJournalFingerprints = new Map();
                try {
                    fs.mkdirSync(asyncDir, { recursive: true });
                    writeRunFanoutBudgetDescriptor(asyncDir, workflowFanoutBudget);
                    fs.mkdirSync(DIRS.results, { recursive: true });
                }
                catch (error) {
                    workflowCapacity?.rollback();
                    return { content: [{ type: "text", text: `Failed to create async workflow storage: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "workflow", results: [] } };
                }
                const controller = new AbortController();
                deps.state.workflowControllers ??= new Map();
                deps.state.workflowChildStops ??= new Map();
                deps.state.workflowControllers.set(workflowRunId, controller);
                workflowCapacity?.markWorkflowStarted();
                if (workflowCapacity)
                    deps.state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(currentSessionId, resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession), { liveWorkflowRunIds: new Set(deps.state.workflowControllers.keys()), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) });
                let status = {
                    runId: workflowRunId,
                    toolCallId,
                    sessionId: currentSessionId ?? undefined,
                    completionOwnerId,
                    mode: "workflow",
                    state: "running",
                    startedAt,
                    lastUpdate: startedAt,
                    ...(timeout !== undefined ? { deadlineAt: startedAt + timeout, timeoutMs: timeout } : {}),
                    cwd: workflowCwd,
                    ...(workflowSessionRoot ? { sessionRoot: workflowSessionRoot } : {}),
                    ...(requestParams.scheduleOrigin ? { scheduleOrigin: requestParams.scheduleOrigin } : {}),
                    pid: process.pid,
                    ...(workflowCapabilityCeiling ? { admissionCapabilityCeiling: workflowCapabilityCeiling } : {}),
                    steps: [],
                    ...(workflowPreflight ? { preflight: workflowPreflight } : {}),
                    workflow: { trace: [], emits: [], console: [], ...workflowRunEvidence, ...(workflowResource ? { resource: workflowResource.provenance } : {}) },
                    workflowChildren: workflowChildSummary({ parentToolCallId: toolCallId, workflowRunId, workflowState: "running", inventoryComplete: false }),
                    runFanoutBudget: getRunFanoutBudgetSnapshot(workflowFanoutBudget),
                };
                const appendWorkflowEvent = (event) => {
                    try {
                        fs.appendFileSync(eventsPath, `${JSON.stringify({ ts: Date.now(), runId: workflowRunId, ...event })}\n`, "utf-8");
                    }
                    catch (error) {
                        // The event log is a journal, not workflow truth. Callers append from
                        // inside run-result handling, so losing an entry to a full disk or to a
                        // transient Windows lock must not fail the run being recorded.
                        console.error(`Failed to append async workflow event '${eventsPath}':`, error);
                    }
                };
                let indexedState;
                const indexPersistence = createCapacityResilientJsonWriter({
                    keepAlive: true,
                    onSuccess: (_filePath, payload) => { indexedState = payload.state; },
                    onError: (error, filePath) => console.error(`Failed to update async workflow index '${filePath}':`, error),
                });
                const queueActiveRunIndex = (snapshot = status) => {
                    const state = snapshot.state;
                    if (indexedState === state && indexPersistence.pendingCount() === 0)
                        return;
                    indexPersistence.write(asyncDir, { state, toolCallId: snapshot.toolCallId }, (_filePath, payload) => {
                        const indexPayload = payload;
                        updateActiveRunIndex(asyncDir, indexPayload.state, indexPayload.toolCallId, { retryCapacityErrors: true });
                    });
                };
                let pendingResultPublication;
                let settleResultPublication;
                let resultWriteFailureWakeDelivered = false;
                const reportResultWriteFailure = (error) => {
                    const message = `Failed to write async workflow result ${resultPath}: ${error instanceof Error ? error.message : String(error)}`;
                    console.error(message, error);
                    try {
                        if (currentSessionId && fallbackResultPayloadPathForSessionRun(path.dirname(resultPath), currentSessionId, workflowRunId))
                            return true;
                    }
                    catch (pendingError) {
                        console.error(`Failed to verify pending async workflow result '${workflowRunId}':`, pendingError);
                    }
                    appendWorkflowEvent({ type: "subagent.workflow.result_write_failed", error: message });
                    // A missing result file means the result watcher will never deliver the
                    // terminal completion wake. Intermediate child notices are context-only
                    // once their turns are suppressed, so surface the failure as its own
                    // actionable wake instead of leaving the parent asleep.
                    if (resultWriteFailureWakeDelivered)
                        return false;
                    if (deps.state.currentSessionId !== currentSessionId || deps.state.completionOwnerId !== completionOwnerId)
                        return false;
                    try {
                        deps.pi.sendMessage({
                            customType: "subagent-workflow-result-write-failed",
                            content: message,
                            display: true,
                        }, { triggerTurn: true });
                        resultWriteFailureWakeDelivered = true;
                    }
                    catch (sendError) {
                        console.error(`Failed to send workflow result write failure notification for '${workflowRunId}':`, sendError);
                    }
                    deps.refreshResultDelivery?.();
                    return false;
                };
                const pendingWorkflowChildAnnouncements = new Map();
                let announcePersistedWorkflowChildren = () => { };
                const runPersistence = createCapacityResilientJsonWriter({
                    keepAlive: true,
                    onSuccess: (filePath, payload) => {
                        if (filePath === statusPath) {
                            announcePersistedWorkflowChildren();
                            queueActiveRunIndex(payload);
                        }
                        if (filePath === resultPath)
                            settleResultPublication?.(true);
                    },
                    onError: (error, filePath) => {
                        if (filePath === resultPath)
                            settleResultPublication?.(reportResultWriteFailure(error));
                        else
                            console.error(`Failed to persist async workflow state '${filePath}':`, error);
                    },
                    write: (filePath, payload) => filePath === resultPath
                        ? writeAsyncResultFile(filePath, payload)
                        : writeAtomicJson(filePath, payload),
                });
                let initialPersistenceComplete = false;
                let persistClosed = false;
                let statusPersistenceDegraded = false;
                // Progress journalling runs from admit, launch, the launch and progress observers,
                // onTrace and onEmit -- all inside the promises a workflowScript awaits. Those
                // callers pass tolerateStatusWriteFailure so a transient lock on status.json cannot
                // mark a finished child failed or abort its still-running siblings. Initial and
                // terminal writes stay fail-fast on purpose: no child work is at risk by then, and
                // silently dropping a terminal write would leave status.json and the active-run
                // index pinned at "running" after the result already says complete.
                const persist = (options = {}) => {
                    if (persistClosed)
                        return;
                    const liveJob = deps.state.asyncJobs.get(workflowRunId);
                    if (liveJob && (liveJob.status === "complete" || liveJob.status === "failed") && status.state !== "complete" && status.state !== "failed")
                        return;
                    const workflowState = status.state === "complete" ? "completed" : status.state === "failed" || status.state === "rejected" ? "failed" : status.state === "paused" ? "paused" : status.state === "stopped" ? "stopped" : "running";
                    status.workflowChildren = workflowChildSummary({ parentToolCallId: toolCallId, workflowRunId, workflowState, inventoryComplete: workflowState !== "running", trace: status.workflow?.trace, steps: status.steps });
                    status.lastUpdate = Date.now();
                    if (!initialPersistenceComplete) {
                        writeAtomicJson(statusPath, status);
                        initialPersistenceComplete = true;
                        queueActiveRunIndex();
                    }
                    else if (options.tolerateStatusWriteFailure) {
                        try {
                            runPersistence.write(statusPath, { ...status });
                            if (runPersistence.pendingCount() === 0)
                                statusPersistenceDegraded = false;
                        }
                        catch (error) {
                            const message = `Failed to persist async workflow state ${statusPath}: ${error instanceof Error ? error.message : String(error)}`;
                            console.error(message, error);
                            if (!statusPersistenceDegraded) {
                                statusPersistenceDegraded = true;
                                try {
                                    appendWorkflowEvent({ type: "subagent.workflow.status_write_failed", error: message });
                                }
                                catch (eventError) {
                                    console.error(`Failed to record degraded status persistence for '${statusPath}':`, eventError);
                                }
                            }
                        }
                    }
                    else {
                        runPersistence.write(statusPath, { ...status });
                    }
                    if (liveJob) {
                        liveJob.status = status.state;
                        liveJob.updatedAt = status.lastUpdate;
                        liveJob.activityState = status.activityState;
                        liveJob.lastActivityAt = status.lastActivityAt;
                        liveJob.currentTool = status.currentTool;
                        liveJob.currentToolStartedAt = status.currentToolStartedAt;
                        liveJob.currentPath = status.currentPath;
                        liveJob.turnCount = status.turnCount;
                        liveJob.toolCount = status.toolCount;
                        liveJob.currentStep = status.currentStep;
                        liveJob.preflight = status.preflight;
                        liveJob.workflowGraph = status.workflowGraph;
                        if (status.steps) {
                            liveJob.steps = status.steps.map((step, index) => ({ ...step, index }));
                            liveJob.agents = status.steps.map((step) => step.agent);
                        }
                        else {
                            delete liveJob.steps;
                            delete liveJob.agents;
                        }
                        liveJob.workflow = status.workflow;
                        liveJob.workflowChildren = status.workflowChildren;
                    }
                };
                const writeWorkflowResult = (payload) => {
                    try {
                        let resultPublished = false;
                        settleResultPublication = (published) => { resultPublished = published; };
                        pendingResultPublication = undefined;
                        runPersistence.write(resultPath, payload);
                        // Only capacity deferral yields; ordinary publication remains synchronous.
                        if (!resultPublished)
                            pendingResultPublication = new Promise((resolve) => { settleResultPublication = resolve; });
                        return true;
                    }
                    catch (error) {
                        return reportResultWriteFailure(error);
                    }
                };
                const projectWorkflowActivity = () => {
                    const steps = status.steps ?? [];
                    const runningSteps = steps.filter((step) => step.status === "running");
                    const lastActivityAt = runningSteps.reduce((latest, step) => step.lastActivityAt === undefined ? latest : Math.max(latest ?? step.lastActivityAt, step.lastActivityAt), undefined);
                    const activeToolStep = runningSteps
                        .filter((step) => step.currentTool)
                        .sort((left, right) => (left.lastActivityAt ?? 0) - (right.lastActivityAt ?? 0))
                        .at(-1);
                    status.activityState = runningSteps.some((step) => step.activityState === "needs_attention")
                        ? "needs_attention"
                        : runningSteps.some((step) => step.activityState === "active_long_running") ? "active_long_running" : undefined;
                    status.lastActivityAt = lastActivityAt;
                    status.currentTool = activeToolStep?.currentTool;
                    status.currentToolStartedAt = activeToolStep?.currentToolStartedAt;
                    status.currentPath = activeToolStep?.currentPath;
                    const turnCounts = steps.flatMap((step) => step.turnCount === undefined ? [] : [step.turnCount]);
                    const toolCounts = steps.flatMap((step) => step.toolCount === undefined ? [] : [step.toolCount]);
                    status.turnCount = turnCounts.length > 0 ? turnCounts.reduce((total, count) => total + count, 0) : undefined;
                    status.toolCount = toolCounts.length > 0 ? toolCounts.reduce((total, count) => total + count, 0) : undefined;
                    status.currentStep = runningSteps.length === 1 ? steps.indexOf(runningSteps[0]) : undefined;
                };
                const workflowJob = { asyncId: workflowRunId, asyncDir, toolCallId, cwd: workflowCwd, ...(workflowSessionRoot ? { sessionRoot: workflowSessionRoot } : {}), status: "running", sessionId: currentSessionId ?? undefined, mode: "workflow", agents: [], steps: [], ...(workflowPreflight ? { preflight: workflowPreflight } : {}), startedAt, updatedAt: startedAt, ...(requestParams.scheduleOrigin ? { scheduleOrigin: requestParams.scheduleOrigin } : {}), ...(timeout !== undefined ? { timeoutMs: timeout, deadlineAt: startedAt + timeout } : {}), workflow: status.workflow, workflowChildren: status.workflowChildren };
                deps.state.asyncJobs.set(workflowRunId, workflowJob);
                deps.state.fleetJobs ??= new Map();
                deps.state.fleetJobs.set(workflowRunId, workflowJob);
                try {
                    persist();
                }
                catch (error) {
                    deps.state.workflowControllers?.delete(workflowRunId);
                    deps.state.asyncJobs.delete(workflowRunId);
                    deps.state.fleetJobs?.delete(workflowRunId);
                    workflowCapacity?.rollback();
                    indexPersistence.dispose();
                    return { content: [{ type: "text", text: `Failed to create async workflow storage: ${error instanceof Error ? error.message : String(error)}` }], isError: true, details: { mode: "workflow", results: [] } };
                }
                appendWorkflowEvent({ type: "subagent.workflow.started", ...(workflowArgsDigest ? { argsDigest: workflowArgsDigest } : {}) });
                try {
                    deps.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
                        lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
                        id: workflowRunId,
                        asyncDir,
                        cwd: workflowCwd,
                        ...(workflowSessionRoot ? { sessionRoot: workflowSessionRoot } : {}),
                        pid: process.pid,
                        sessionId: currentSessionId ?? undefined,
                        completionOwnerId,
                        mode: "workflow",
                        agent: "workflow",
                        goal: derivedObjective.trim() ? PROMPT_REDACTED : undefined,
                        ...(timeout !== undefined ? { timeoutMs: timeout, deadlineAt: startedAt + timeout } : {}),
                    });
                }
                catch (error) {
                    console.error("Failed to emit async workflow start event:", error);
                }
                // The runner does not execute workflow scripts: this active owner must consume its own
                // durable steer inbox, deliver through in-process child controls, and persist receipts.
                const emitWorkflowSteerEvent = (type, requestId, index, extra = {}) => {
                    appendWorkflowEvent({ type, requestId, ...(index !== undefined ? { index } : {}), ...extra });
                };
                const recordWorkflowSteerTargets = (request, targets) => {
                    status.steering ??= createSteeringStatus();
                    recordSteeringRequest(steeringStatus(status), {
                        id: request.id,
                        requestedAt: request.ts,
                        ...(request.source ? { source: request.source } : {}),
                        message: request.message,
                        targets,
                    });
                };
                const explicitWorkflowSteerIndexes = (request) => request.targetIndex !== undefined ? [request.targetIndex] : request.targetIndexes;
                const failWorkflowSteer = (request, indexes, reason) => {
                    const targets = indexes.map((index) => ({ index, state: "failed", reason }));
                    recordWorkflowSteerTargets(request, targets);
                    emitWorkflowSteerEvent("subagent.steer.requested", request.id, undefined, { targets });
                    for (const index of indexes)
                        emitWorkflowSteerEvent("subagent.steer.failed", request.id, index, { reason });
                    persist({ tolerateStatusWriteFailure: true });
                };
                const pendingWorkflowSteers = new Set();
                const deliverWorkflowSteerRequest = (request) => {
                    let indexes = explicitWorkflowSteerIndexes(request);
                    if (status.state !== "running") {
                        failWorkflowSteer(request, indexes ?? [0], `run became ${status.state} before steering request was consumed`);
                        return;
                    }
                    const liveControls = [...deps.state.foregroundControls.values()].filter((candidate) => candidate.parentWorkflowRunId === workflowRunId && (candidate.activeChildren?.size ?? 0) > 0);
                    if (indexes === undefined) {
                        if (liveControls.length !== 1) {
                            failWorkflowSteer(request, [0], liveControls.length > 1
                                ? `workflow has ${liveControls.length} live children; steer a child run id instead`
                                : "workflow child is not live in this process");
                            return;
                        }
                        const index = status.steps?.findIndex((step) => !!step.workflowKey && step.workflowKey === liveControls[0].workflowKey) ?? -1;
                        if (index < 0) {
                            failWorkflowSteer(request, [0], "live workflow child has no projected step");
                            return;
                        }
                        indexes = [index];
                    }
                    // Normalize and record the whole set once: recordSteeringRequest is idempotent by id.
                    // Explicit indexes resolve only by their projected key, never by a live sibling.
                    const resolved = indexes.map((index) => {
                        const step = status.steps?.[index];
                        const control = step?.workflowKey ? liveControls.find((candidate) => candidate.workflowKey === step.workflowKey) : undefined;
                        return { index, control, reason: !step ? "child index out of range" : !control ? "workflow child is not live in this process" : undefined };
                    });
                    const targets = resolved.map(({ index, reason }) => ({ index, state: reason ? "failed" : "routed", ...(reason ? { reason } : {}) }));
                    recordWorkflowSteerTargets(request, targets);
                    emitWorkflowSteerEvent("subagent.steer.requested", request.id, undefined, { targets });
                    persist({ tolerateStatusWriteFailure: true });
                    for (const { index, control, reason } of resolved) {
                        if (!control) {
                            emitWorkflowSteerEvent("subagent.steer.failed", request.id, index, { reason });
                            continue;
                        }
                        emitWorkflowSteerEvent("subagent.steer.routed", request.id, index);
                        const applyWorkflowSteerDelivery = (state, reason) => {
                            // Shutdown settles unresolved receipts synchronously; late SDK callbacks cannot rewrite them.
                            if (!pendingWorkflowSteers.has(applyWorkflowSteerDelivery))
                                return;
                            // Queuing is not confirmation of delivery: retain ownership until terminal settlement.
                            if (state !== "queued")
                                pendingWorkflowSteers.delete(applyWorkflowSteerDelivery);
                            const now = Date.now();
                            const steering = steeringStatus(status);
                            // This callback owns a pending target, even after bounded display history
                            // evicts its request. Account independently; queued still represents one pending target.
                            if (state !== "queued")
                                steering.pending = Math.max(0, steering.pending - 1);
                            if (state === "delivered") {
                                steering.delivered++;
                                steering.lastDeliveredAt = now;
                            }
                            else if (state === "failed")
                                steering.failed++;
                            const receipt = steering.recent.find((candidate) => candidate.id === request.id)?.targets.find((target) => target.index === index);
                            if (receipt) {
                                receipt.state = state;
                                if (state === "delivered")
                                    receipt.deliveredAt = now;
                                if (state === "failed")
                                    receipt.failedAt = now;
                                if (reason)
                                    receipt.reason = reason;
                            }
                            if (state === "failed") {
                                const failedStep = status.steps?.[index];
                                if (failedStep)
                                    failedStep.activityState = "needs_attention";
                                status.activityState = "needs_attention";
                            }
                            emitWorkflowSteerEvent(`subagent.steer.${state}`, request.id, index, state === "failed" ? { reason } : { deliveryStatus: state, message: request.message });
                            persist({ tolerateStatusWriteFailure: true });
                        };
                        pendingWorkflowSteers.add(applyWorkflowSteerDelivery);
                        void steerWorkflowForegroundTarget({
                            target: { control, workflowRunId, sourceRunId: workflowRunId },
                            message: request.message,
                            ...(request.mode ? { mode: request.mode } : {}),
                        }).then((result) => {
                            const target = result.details.steering?.targets[0];
                            applyWorkflowSteerDelivery(target?.state === "delivered" ? "delivered" : target?.state === "queued" ? "queued" : "failed", target?.reason ?? (target ? undefined : "steering produced no target receipt"));
                        }, (error) => applyWorkflowSteerDelivery("failed", error instanceof Error ? error.message : String(error)));
                    }
                };
                let disposeWorkflowSteerInbox;
                try {
                    disposeWorkflowSteerInbox = watchAsyncControlInbox(asyncDir, {
                        onSteer: deliverWorkflowSteerRequest,
                        onError: (error, phase, request) => {
                            const reason = error instanceof Error ? error.message : String(error);
                            appendWorkflowEvent({ type: "subagent.workflow.steer_inbox_unavailable", phase, error: reason });
                            if (request)
                                failWorkflowSteer(request, explicitWorkflowSteerIndexes(request) ?? [0], `steer consumer failed: ${reason}`);
                        },
                    });
                }
                catch (error) {
                    // Steering is an optional control surface, so a watcher that cannot install must not fail the run.
                    appendWorkflowEvent({ type: "subagent.workflow.steer_inbox_unavailable", error: error instanceof Error ? error.message : String(error) });
                }
                deps.activateSupervisorTransport?.();
                const { workflowScript, async: _workflowAsync, chatProgress: _chatProgress, ...workflowRequest } = requestParams;
                let workflowSteerInboxClosed = false;
                const settleWorkflowSteerInbox = (outcome = status.state) => {
                    if (workflowSteerInboxClosed)
                        return;
                    workflowSteerInboxClosed = true;
                    disposeWorkflowSteerInbox?.();
                    // Consumed deliveries are not files anymore. Fail unresolved SDK operations without awaiting them.
                    for (const settle of pendingWorkflowSteers)
                        settle("failed", `run became ${outcome} before steering delivery settled; delivery unconfirmed`);
                    try {
                        closeSteerInbox(asyncDir, outcome);
                        // Separately drain requests that never reached the consumer.
                        const undelivered = consumeSteerRequests(asyncDir, undefined, (error) => {
                            appendWorkflowEvent({ type: "subagent.workflow.steer_inbox_unavailable", phase: "drain", error: error instanceof Error ? error.message : String(error) });
                        });
                        for (const request of undelivered)
                            failWorkflowSteer(request, explicitWorkflowSteerIndexes(request) ?? [0], `run became ${outcome} before steering request was consumed`);
                    }
                    catch (error) {
                        appendWorkflowEvent({ type: "subagent.workflow.steer_inbox_unavailable", phase: "close", error: error instanceof Error ? error.message : String(error) });
                    }
                    // Commit receipts while run status is still nonterminal. Result/index publication
                    // can fail next; teardown must not publish the subsequently computed terminal status.
                    persist();
                };
                void Promise.resolve().then(async () => {
                    const workflowDeadlineAt = timeout === undefined ? undefined : Date.now() + timeout;
                    const workflowResults = [];
                    const workflowChildRunIds = new Map();
                    const { args: _args, action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, missionId: _missionId, mission: _mission, preflight: _preflight, globalConcurrencyLimit: _globalConcurrencyLimit, maxSubagentSpawnsPerRun: _maxSubagentSpawnsPerRun, ...workflowChildDefaults } = workflowRequest;
                    const workflowOutput = typeof workflowChildDefaults.output === "string" || typeof workflowChildDefaults.output === "boolean" ? workflowChildDefaults.output : undefined;
                    const configuredOutputBaseDir = resolveConfiguredSingleRunOutputBaseDir(deps);
                    const workflowAggregateOutputPath = resolveSingleOutputPath(workflowOutput, parentCwd, workflowCwd, resolveSingleRunOutputBaseDir(deps, workflowArtifactsDir, workflowRunId));
                    const claimedOutputPaths = new Map();
                    const childOutputOverrides = new Map();
                    const childOutputClaimPaths = new Map();
                    const producedChildOutputPaths = new Set();
                    const workflowSteps = new Map();
                    const announcedWorkflowChildren = new Set();
                    const announceWorkflowChild = (key, step) => {
                        if (announcedWorkflowChildren.has(key))
                            return;
                        announcedWorkflowChildren.add(key);
                        const stepIndex = status.steps?.indexOf(step);
                        const childEvent = {
                            type: "subagent.child-status",
                            version: 1,
                            runId: workflowRunId,
                            childId: key,
                            status: "started",
                            ts: Date.now(),
                            source: "async",
                            asyncDir,
                            ...(stepIndex !== undefined ? { stepIndex } : {}),
                            agent: step.agent,
                            ...(step.runId ? { childRunId: step.runId } : {}),
                            workflowKey: key,
                            ...(step.phase ? { phase: step.phase } : {}),
                            ...(step.label ? { label: step.label } : {}),
                        };
                        appendWorkflowEvent({ ...childEvent });
                        try {
                            deps.pi.events.emit(SUBAGENT_CHILD_STATUS_EVENT, childEvent);
                        }
                        catch (error) {
                            console.error("Failed to emit workflow child status event:", error);
                        }
                    };
                    announcePersistedWorkflowChildren = () => {
                        for (const [key, step] of pendingWorkflowChildAnnouncements) {
                            if (!step.runId)
                                continue;
                            announceWorkflowChild(key, step);
                            pendingWorkflowChildAnnouncements.delete(key);
                        }
                    };
                    const runHostCommand = workflowHostCommandRunner({
                        workflowCwd,
                        artifactsDir: workflowArtifactsDir,
                        workflowRunId,
                        claimedOutputPaths,
                        producedOutputPaths: producedChildOutputPaths,
                        ...(workflowResource ? { authorize: (key, params) => authorizeWorkflowResourceHost(workflowResource.permit, key, params.command) } : {}),
                    });
                    const workflowHost = workflowResource
                        ? workflowResource.authority.host ? runHostCommand : undefined
                        : publicExecution ? undefined : runHostCommand;
                    let projectedTraceLength = 0;
                    let projectedTraceTail;
                    const updateTrace = (trace) => {
                        const projectedTrace = annotateWorkflowPreflightTrace(trace, workflowPreflight);
                        const preflightWarnings = workflowPreflightWarnings(workflowPreflight, trace);
                        status.workflow = {
                            ...(status.workflow ?? { emits: [], console: [] }),
                            trace: projectedTrace,
                            ...(preflightWarnings.length ? { preflightWarnings } : {}),
                        };
                        if (status.workflowGraph)
                            applyWorkflowLaneTrace(status.workflowGraph, trace);
                        const rebuild = trace.length < projectedTraceLength
                            || (projectedTraceLength > 0 && trace[projectedTraceLength - 1] !== projectedTraceTail);
                        if (rebuild) {
                            workflowSteps.clear();
                            for (const step of status.steps ?? []) {
                                if (step.workflowKey)
                                    workflowSteps.set(step.workflowKey, step);
                            }
                            projectedTraceLength = 0;
                        }
                        for (let index = projectedTraceLength; index < trace.length; index += 1) {
                            const entry = trace[index];
                            if (entry.operation !== "run")
                                continue;
                            const entryLabel = entry.label?.trim() || undefined;
                            const entryPhase = entry.phase?.trim() || undefined;
                            const shouldProjectPhase = entryPhase !== undefined && (entryPhase !== "auto-resume" || workflowSteps.get(entry.key)?.phase === undefined);
                            const existing = workflowSteps.get(entry.key);
                            if (existing) {
                                if (entryLabel)
                                    existing.label = entryLabel;
                                if (shouldProjectPhase)
                                    existing.phase = entryPhase;
                            }
                            if (entry.state === "reused" && existing) {
                                continue;
                            }
                            const mapped = entry.state === "started" || entry.state === "reused"
                                ? "running"
                                : entry.state === "completed"
                                    ? "completed"
                                    : entry.state === "stopped"
                                        ? "stopped"
                                        : entry.state === "detached"
                                            ? "paused"
                                            : "failed";
                            if (existing) {
                                existing.status = mapped;
                                if (entry.agent)
                                    existing.agent = entry.agent;
                                if (entry.runId)
                                    existing.runId = entry.runId;
                                if (entry.state === "failed" && !entry.runId && existing.async === undefined)
                                    existing.async = false;
                                if (entry.state === "detached")
                                    existing.activityState = "needs_attention";
                                else if (existing.status !== "running")
                                    delete existing.activityState;
                                if (entry.state === "stopped")
                                    existing.stopped = true;
                                else
                                    delete existing.stopped;
                                if (entry.error === undefined)
                                    delete existing.error;
                                else
                                    existing.error = entry.error;
                                if (entry.durationMs === undefined)
                                    delete existing.durationMs;
                                else
                                    existing.durationMs = entry.durationMs;
                            }
                            else {
                                // Naming uses the explicit label only — never the workflow key — so the
                                // placeholder cannot diverge from the task-derived name the child
                                // session actually gets (launch/progress updates overwrite this).
                                const stepSessionName = deriveChildSessionName({ agent: entry.agent ?? entry.key, label: entryLabel });
                                const step = {
                                    agent: entry.agent ?? entry.key,
                                    ...(stepSessionName ? { sessionName: stepSessionName } : {}),
                                    label: entryLabel ?? entry.key,
                                    workflowKey: entry.key,
                                    parentWorkflowRunId: workflowRunId,
                                    status: mapped,
                                    startedAt: Date.now(),
                                    ...(entryPhase ? { phase: entryPhase } : {}),
                                    ...(entry.runId ? { runId: entry.runId } : {}),
                                    ...(entry.state === "failed" && !entry.runId ? { async: false } : {}),
                                    ...(entry.state === "detached" ? { activityState: "needs_attention" } : {}),
                                    ...(entry.state === "stopped" ? { stopped: true } : {}),
                                };
                                status.steps?.push(step);
                                workflowSteps.set(entry.key, step);
                            }
                            const projectedStep = workflowSteps.get(entry.key);
                            if (entry.reused && projectedStep)
                                projectedStep.reused = true;
                            if (entry.state === "stopped" && projectedStep) {
                                appendWorkflowEvent({
                                    type: "subagent.child-status",
                                    version: 1,
                                    childId: entry.key,
                                    status: "stopped",
                                    reason: "subagent-action",
                                    source: "async",
                                    stepIndex: status.steps?.indexOf(projectedStep),
                                    agent: projectedStep.agent,
                                    ...(projectedStep.runId ? { childRunId: projectedStep.runId } : {}),
                                    workflowKey: entry.key,
                                    ...(projectedStep.phase ? { phase: projectedStep.phase } : {}),
                                    ...(projectedStep.label ? { label: projectedStep.label } : {}),
                                });
                            }
                        }
                        projectedTraceLength = trace.length;
                        projectedTraceTail = trace.at(-1);
                        projectWorkflowActivity();
                        persist({ tolerateStatusWriteFailure: true });
                        appendWorkflowEvent({ type: "subagent.workflow.trace", trace });
                    };
                    try {
                        const workflow = await runWorkflowScript({
                            script: workflowScript,
                            ...(workflowArgs ? { args: workflowArgs } : {}),
                            workflowRunId,
                            processCwd: ctx.cwd,
                            globalConcurrencyLimit: requestParams.globalConcurrencyLimit ?? deps.config.globalConcurrencyLimit,
                            timeoutMs: timeout,
                            signal: controller.signal,
                            continueAfterAbortWhenChildrenSettled: (abortError) => {
                                if (!workflowStopCause(abortError))
                                    return false;
                                const activeAsyncChild = [...(deps.state.asyncJobs?.values() ?? [])].some((job) => job.parentWorkflowRunId === workflowRunId && (job.status === "queued" || job.status === "running"));
                                const activeForegroundChild = [...deps.state.foregroundControls.values()].some((control) => control.parentWorkflowRunId === workflowRunId && (control.activeChildren?.size ?? 0) > 0);
                                return !activeAsyncChild && !activeForegroundChild;
                            },
                            registerStopChild: (stop) => {
                                if (stop)
                                    deps.state.workflowChildStops?.set(workflowRunId, stop);
                                else
                                    deps.state.workflowChildStops?.delete(workflowRunId);
                            },
                            ...(workflowState ? { state: workflowState } : {}),
                            onTrace: updateTrace,
                            onChildSettled: (notification) => {
                                const journalFingerprint = workflowJournalFingerprints.get(notification.childKey);
                                if (journalFingerprint)
                                    appendWorkflowChildJournal(asyncDir, { type: "settle", key: notification.childKey, fingerprint: journalFingerprint, result: notification.result });
                                appendWorkflowEvent({
                                    type: "subagent.workflow.child_settled",
                                    childKey: notification.childKey,
                                    ...(notification.childRunId ? { childRunId: notification.childRunId } : {}),
                                    outcome: notification.outcome,
                                    workflowRunning: notification.workflowRunning,
                                });
                                try {
                                    deps.pi.sendMessage({
                                        customType: "subagent-incremental-child-notify",
                                        content: formatIncrementalChildCompletion(notification),
                                        display: notification.outcome !== "completed",
                                    }, { triggerTurn: incrementalChildCompletionTriggersTurn(notification, requestParams.scheduleOrigin) });
                                }
                                catch (sendError) {
                                    console.error(`Failed to send incremental child completion notification for '${notification.childKey}':`, sendError);
                                }
                                deps.refreshResultDelivery?.();
                            },
                            onLanePlan: (lanes) => {
                                status.workflowGraph = buildWorkflowLaneGraph(workflowRunId, lanes, status.workflowGraph);
                                applyWorkflowLaneTrace(status.workflowGraph, status.workflow?.trace ?? []);
                                persist({ tolerateStatusWriteFailure: true });
                            },
                            ...(workflowHost ? { host: workflowHost } : {}),
                            onHostStep: (hostStep) => {
                                status = upsertHostStep({ status, hostStep, persist: (nextStatus) => {
                                        status = nextStatus;
                                        persist({ tolerateStatusWriteFailure: true });
                                    } });
                            },
                            admit: async (calls, admissionSignal) => {
                                admitEnabledWorkflowChildren(calls);
                                await preflightWorkflowWorktrees({ workflowDefaults: workflowChildDefaults, defaultWorktree: deps.config.worktree, calls, ctxCwd: parentCwd, signal: admissionSignal, deadlineAt: workflowDeadlineAt });
                                const outputClaims = workflowChildOutputClaims({ ctxCwd: parentCwd, workflowCwd, artifactsDir: workflowArtifactsDir, workflowRunId, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: discoverWorkflowAgents, agents: workflowAgents, workflowAgentScope: workflowChildDefaults.agentScope, state: deps.state, claimedOutputPaths, entries: calls });
                                if (outputClaims.error)
                                    throw new Error(outputClaims.error);
                                status.runFanoutBudget = claimRunFanoutBatch(workflowFanoutBudget, calls.map(({ key }) => `workflow[${key}]`));
                                if (outputClaims.claims)
                                    applyWorkflowChildOutputClaims(claimedOutputPaths, outputClaims.claims);
                                if (outputClaims.childClaims)
                                    for (const [key, claimPath] of outputClaims.childClaims)
                                        childOutputClaimPaths.set(key, claimPath);
                                if (outputClaims.overrides)
                                    for (const [key, output] of outputClaims.overrides)
                                        childOutputOverrides.set(key, output);
                                persist({ tolerateStatusWriteFailure: true });
                            },
                            onEmit: (emits) => {
                                // Each emit is validated at the host boundary in runWorkflowScript before onEmit fires.
                                status.workflow = { ...(status.workflow ?? { trace: [], console: [] }), emits };
                                persist({ tolerateStatusWriteFailure: true });
                                appendWorkflowEvent({ type: "subagent.workflow.emit", value: emits.at(-1) });
                            },
                            launch: async (key, childParams, workflowSignal, admission) => {
                                const journalFingerprint = workflowJournalFingerprints.get(key) ?? workflowChildFingerprint(childParams);
                                workflowJournalFingerprints.set(key, journalFingerprint);
                                const priorChild = workflowReuseSource ? matchWorkflowReuse(workflowReuseSource, key, journalFingerprint) : undefined;
                                if (priorChild?.kind === "settled") {
                                    if (priorChild.result.runId)
                                        workflowChildRunIds.set(key, priorChild.result.runId);
                                    return { ...priorChild.result, reused: true };
                                }
                                if (priorChild?.kind === "started") {
                                    // The previous run's awaited async child may still be running: wait for that exact run
                                    // instead of launching again. Journal it first so another reload can re-attach too.
                                    const priorRunId = priorChild.runId;
                                    const priorAsyncDir = path.join(DIRS.async, priorRunId);
                                    appendWorkflowChildJournal(asyncDir, { type: "start", key, fingerprint: journalFingerprint, runId: priorRunId });
                                    const stopListener = stopAwaitedAsyncChildOnAbort(workflowSignal, deps.state, priorRunId, priorAsyncDir, deps.kill);
                                    const reattached = await awaitExistingAsyncRun(priorAsyncDir, priorRunId, workflowSignal).finally(stopListener.remove);
                                    const claimedPath = reattached.status === "settled" ? claimWorkflowAwaitedResult(priorAsyncDir, workflowRunId) : undefined;
                                    if (reattached.status === "settled" && claimedPath) {
                                        const imported = importWorkflowAwaitedChildResult(reattached.result, { runId: priorRunId, asyncDir: priorAsyncDir, resultPath: claimedPath, task: typeof childParams.task === "string" ? childParams.task : "", parentWorkflowRunId: workflowReuseSource?.runId, details: { mode: "single", asyncId: priorRunId, asyncDir: priorAsyncDir, results: [] }, state: deps.state, pi: deps.pi });
                                        const reattachedResult = workflowChildResult(key, imported, childParams, deps.state);
                                        // Like a settled journal match: only a successful child is reused; a failed or stopped one launches fresh.
                                        if (reattachedResult.ok) {
                                            workflowChildRunIds.set(key, priorRunId);
                                            return { ...reattachedResult, reused: true };
                                        }
                                    }
                                }
                                if (workflowUsageBudget.budget && childParams.async === true)
                                    return workflowChildResult(key, buildRequestedModeError(childParams, "workflow usageBudget does not support async runs.run launches."), childParams, deps.state);
                                const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
                                if (budgetState?.exhausted)
                                    return workflowChildResult(key, buildRequestedModeError(childParams, usageBudgetExceededMessage(budgetState)), childParams, deps.state, { state: "partial", reason: "budget_exhausted" });
                                const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
                                const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
                                recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
                                    status: "running",
                                    ...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
                                    ...(childLabel ? { label: childLabel } : {}),
                                    ...(childPhase ? { phase: childPhase } : {}),
                                    heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
                                });
                                let preparedChildParams;
                                const result = await runMissionWorkflowChild(missionBinding, workflowRunId, key, childPhase, () => {
                                    const childRequest = bindMissionWorkflowChildAsyncLaunch({ ...prepareWorkflowChildLaunchParams({ workflowDefaults: workflowChildDefaults, childParams, parentWorkflowRunId: workflowRunId, workflowKey: key, ctxCwd: parentCwd, workflowCwd, artifactsDir: workflowArtifactsDir, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: discoverWorkflowAgents, agents: workflowAgents, workflowAgentScope: workflowChildDefaults.agentScope, outputOverride: childOutputOverrides.get(key), outputClaimPath: childOutputClaimPaths.get(key), options: { missionDetached: detachWorkflowChildMissions, awaitDetachedChild: true, runFanoutBudget: workflowFanoutBudget, parentDeadlineAt: workflowDeadlineAt, capabilityCeiling: workflowCapabilityCeiling } }), runFanoutAdmitted: admission.admitted }, missionBinding, deps.asyncByDefault, undefined, inheritedNestedRoute(deps)?.rootRunId);
                                    preparedChildParams = childRequest;
                                    if (workflowUsageBudget.budget)
                                        workflowOwnedUsageBudgets.set(childRequest, workflowUsageBudget.budget);
                                    workflowLaunchObservers.set(childRequest, (launch) => {
                                        if (launch.runId)
                                            appendWorkflowChildJournal(asyncDir, { type: "start", key, fingerprint: journalFingerprint, runId: launch.runId });
                                        const step = status.steps?.find((candidate) => candidate.workflowKey === key);
                                        if (step) {
                                            step.agent = launch.agent;
                                            if (launch.sessionName)
                                                step.sessionName = launch.sessionName;
                                            step.sessionFile = launch.sessionFile;
                                            step.async = launch.async;
                                            if (launch.runId)
                                                step.runId = launch.runId;
                                            if (childRequest.lane)
                                                step.lane = childRequest.lane;
                                            if (step.runId)
                                                pendingWorkflowChildAnnouncements.set(key, step);
                                            persist({ tolerateStatusWriteFailure: true });
                                        }
                                        recordMissionWorkflowChild(missionBinding, workflowRunId, key, { status: "running", agent: launch.agent, ...(launch.sessionFile ? { sessionPath: launch.sessionFile } : {}) });
                                    });
                                    return execute(randomUUID(), childRequest, workflowSignal, (update) => {
                                        const progress = update.details.progress?.[0];
                                        const step = status.steps?.find((candidate) => candidate.workflowKey === key);
                                        if (!progress || !step || step.stopped)
                                            return;
                                        step.status = progress.status === "completed" ? "completed" : progress.status === "failed" ? "failed" : "running";
                                        step.activityState = progress.activityState;
                                        step.lastActivityAt = progress.lastActivityAt;
                                        step.currentTool = progress.currentTool;
                                        step.currentToolArgs = progress.currentToolArgs;
                                        step.currentToolStartedAt = progress.currentToolStartedAt;
                                        step.currentPath = progress.currentPath;
                                        step.recentTools = progress.recentTools.map((tool) => ({ ...tool }));
                                        step.recentOutput = [...progress.recentOutput];
                                        step.turnCount = progress.turnCount;
                                        step.toolCount = progress.toolCount;
                                        step.model = progress.model;
                                        step.thinking = progress.thinking;
                                        if (progress.sessionName)
                                            step.sessionName = progress.sessionName;
                                        step.error = progress.error;
                                        projectWorkflowActivity();
                                        persist({ tolerateStatusWriteFailure: true });
                                        recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
                                            status: step.status,
                                            heartbeat: { status: step.status, ...(childPhase ? { phase: childPhase } : {}) },
                                        });
                                    }, ctx, preserveActiveSession, workflowParentModel);
                                });
                                workflowResults.push(...result.details.results);
                                for (const childResult of result.details.results) {
                                    if (childResult.savedOutputPath)
                                        producedChildOutputPaths.add(resolveWorkflowHostOutputClaimPath(childResult.savedOutputPath));
                                }
                                const child = workflowChildResult(key, result, preparedChildParams ?? childParams, deps.state);
                                if (child.runId)
                                    workflowChildRunIds.set(key, child.runId);
                                const step = status.steps?.find((candidate) => candidate.workflowKey === key);
                                if (step) {
                                    step.async = step.async === true || Boolean(result.details.asyncId || result.details.asyncDir);
                                    if (child.runId)
                                        step.runId = child.runId;
                                    if (child.lane)
                                        step.lane = child.lane;
                                }
                                if (result.details.asyncDir && missionBinding)
                                    writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
                                const childStatus = missionWorkflowChildStatus(result);
                                recordMissionWorkflowChild(missionBinding, workflowRunId, key, {
                                    status: childStatus,
                                    ...(child.runId ? { runId: child.runId } : {}),
                                    ...(result.details.results[0]?.agent ? { agent: result.details.results[0].agent } : {}),
                                    ...(result.details.results[0]?.sessionFile ? { sessionPath: result.details.results[0].sessionFile } : {}),
                                    artifactPaths: child.artifactPaths,
                                    ...(["completed", "failed"].includes(childStatus) ? { completedAt: new Date().toISOString() } : {}),
                                    heartbeat: { status: childStatus, ...(childPhase ? { phase: childPhase } : {}) },
                                });
                                if (result.details.asyncId) {
                                    const childJob = deps.state.asyncJobs.get(result.details.asyncId);
                                    if (childJob) {
                                        childJob.parentWorkflowRunId = workflowRunId;
                                        childJob.workflowKey = key;
                                    }
                                }
                                return child;
                            },
                            status: async (keyOrRunId, workflowSignal) => workflowChildResult(keyOrRunId, await execute(randomUUID(), { action: "status", id: keyOrRunId }, workflowSignal, undefined, ctx, preserveActiveSession, workflowParentModel)),
                            resolveResume: (reference, _signal, index) => resolveWorkflowResume(reference, deps, ctx.sessionManager.getSessionFile() ?? null, index),
                            steer: (key, message, options, workflowSignal) => steerWorkflowChildByKey({ state: deps.state, workflowRunId, key, message, options, signal: workflowSignal, resolveRunId: () => workflowChildRunIds.get(key) }),
                        });
                        const finalPreflightWarnings = workflowPreflightWarnings(workflowPreflight, workflow.trace, { settled: true });
                        const finalPreflightTrace = annotateWorkflowPreflightTrace(workflow.trace, workflowPreflight);
                        const returnText = formatWorkflowValue(workflow.value);
                        const emitText = workflow.emits.map(formatWorkflowValue).join(", ");
                        const returnPreview = returnText.length > 1_000 ? `${returnText.slice(0, 1_000)}…` : returnText;
                        const emitPreview = workflow.emits.length > 0 ? ` Emitted: ${emitText.length > 1_000 ? `${emitText.slice(0, 1_000)}…` : emitText}` : "";
                        const previewNote = returnText.length > 1_000 || emitText.length > 1_000 ? ` (truncated; full return value and emits: ${statusPath} (workflow.value, workflow.emits))` : "";
                        const runningSummary = workflowRunningChildrenSummary(workflow.children);
                        const summary = `${runningSummary ? `Workflow dispatch completed; ${runningSummary}` : `Workflow completed with ${workflow.children.length} child run(s).`} Return: ${returnPreview}${emitPreview}${previewNote} Trace: ${workflow.trace.length} event(s).${workflowOutputPathMappingSummary(workflow.children)}${finalPreflightWarnings.length ? ` ${finalPreflightWarnings.join(" ")}` : ""}`;
                        const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, summary, producedChildOutputPaths);
                        const resultSummary = appendWorkflowOutputWarning(summary, outputWarning);
                        const workflowUsage = sumResultsUsage(workflowResults);
                        settleWorkflowSteerInbox("complete");
                        const workflowChildren = workflowChildSummary({ parentToolCallId: toolCallId, workflowRunId, workflowState: "completed", inventoryComplete: true, trace: workflow.trace, children: workflow.children, steps: status.steps });
                        status = { ...status, state: "complete", endedAt: Date.now(), workflow: { value: workflow.value, trace: finalPreflightTrace, emits: workflow.emits, console: workflow.console, ...workflowRunEvidence, ...(workflowResource ? { resource: workflowResource.provenance } : {}), ...(finalPreflightWarnings.length ? { preflightWarnings: finalPreflightWarnings } : {}) }, workflowChildren, totalTokens: { input: workflowUsage.input, output: workflowUsage.output, total: workflowUsage.input + workflowUsage.output }, totalCost: sumResultsCost(workflowResults) };
                        const receipt = terminalWorkflowReceipt(workflowRunId, "complete", workflow.children, workflowChildren, undefined, validHostStepNodes(status.workflowGraph), workflowResource?.provenance, workflowArgsDigest);
                        delete status.workflowReceiptPath;
                        let workflowReceipt;
                        try {
                            workflowReceipt = { path: writeWorkflowReceipt(asyncDir, receipt), receipt };
                            status.workflowReceiptPath = workflowReceipt.path;
                        }
                        catch (receiptError) {
                            appendWorkflowEvent({ type: "subagent.workflow.receipt_write_failed", error: `Failed to persist async workflow receipt: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}` });
                        }
                        if (!writeWorkflowResult({ id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: true, state: "complete", summary: resultSummary, output: resultSummary, workflowChildren, results: workflowResultChildren(workflow.children, status, false), workflow: status.workflow, ...(workflowCapabilityCeiling ? { admissionCapabilityCeiling: workflowCapabilityCeiling } : {}), ...(workflowReceipt ? { workflowReceipt } : {}), asyncDir, cwd: workflowCwd, sessionId: currentSessionId, completionOwnerId, ...(requestParams.scheduleOrigin ? { scheduleOrigin: requestParams.scheduleOrigin } : {}), timestamp: Date.now(), durationMs: Date.now() - startedAt }))
                            return;
                        if (pendingResultPublication && !await pendingResultPublication)
                            return;
                        persist();
                        deps.refreshResultDelivery?.();
                        persistClosed = true;
                        appendWorkflowEvent({ type: "subagent.workflow.completed", state: status.state, ...(workflowArgsDigest ? { argsDigest: workflowArgsDigest } : {}), ...(status.error ? { error: status.error } : {}) });
                    }
                    catch (error) {
                        const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
                        const stopped = controller.signal.aborted;
                        const stopCause = stopped ? workflowStopCause(controller.signal.reason) : undefined;
                        if (stopCause)
                            workflowRunEvidence.stopCause = stopCause;
                        const detachedChildKeys = new Set(partial.children.filter((child) => child.detached).map((child) => child.key));
                        const hasRealFailedChild = partial.children.some((child) => !child.ok && child.state !== "running" && !child.detached);
                        const pauseForDetached = !stopped && error instanceof WorkflowScriptError && error.errorKind === "detached-child" && detachedChildKeys.size > 0 && !hasRealFailedChild;
                        const state = stopped ? "stopped" : pauseForDetached ? "paused" : "failed";
                        for (const step of status.steps ?? []) {
                            if (step.workflowKey && detachedChildKeys.has(step.workflowKey)) {
                                if (step.status === "completed" || step.status === "complete" || step.status === "failed")
                                    continue;
                                step.status = "paused";
                                step.activityState = "needs_attention";
                            }
                            else if (pauseForDetached && step.status === "running") {
                                step.status = "stopped";
                                step.stopped = true;
                                delete step.activityState;
                            }
                        }
                        const workflowState = state === "paused" ? "paused" : state === "stopped" ? "stopped" : "failed";
                        settleWorkflowSteerInbox(state);
                        const workflowChildren = workflowChildSummary({ parentToolCallId: toolCallId, workflowRunId, workflowState, inventoryComplete: true, trace: partial.trace, children: partial.children, steps: status.steps });
                        const finalPreflightWarnings = workflowPreflightWarnings(workflowPreflight, partial.trace, { settled: true });
                        const finalPreflightTrace = annotateWorkflowPreflightTrace(partial.trace, workflowPreflight);
                        status = compactOptional({ ...status, state, stopped: stopped || undefined, activityState: pauseForDetached || status.activityState === "needs_attention" ? "needs_attention" : undefined, error: workflowFailureMessage(error, workflowRunId, partial.children), endedAt: Date.now(), workflow: { trace: finalPreflightTrace, emits: partial.emits, console: partial.console, ...(error instanceof WorkflowScriptError && error.errorKind ? { failureKind: error.errorKind } : {}), ...workflowRunEvidence, ...(workflowResource ? { resource: workflowResource.provenance } : {}), ...(finalPreflightWarnings.length ? { preflightWarnings: finalPreflightWarnings } : {}) }, workflowChildren });
                        if (pauseForDetached) {
                            const promoted = promotePausedWorkflowIfSettled(status);
                            if (promoted)
                                status = promoted;
                        }
                        // A script can throw an error of any size; status.json keeps the full text.
                        const errorPreview = status.error && status.error.length > 1_000 ? `${status.error.slice(0, 1_000)}… (truncated; full error: ${statusPath} (error))` : status.error;
                        const terminalSummary = `${status.state === "complete"
                            ? "Workflow completed after detached child finished."
                            : errorPreview ?? (pauseForDetached ? "Workflow paused." : "Workflow failed.")}${stopCause ? ` ${WORKFLOW_RUNTIME_REPLACED_RELAUNCH_NOTICE}` : ""}${workflowOutputPathMappingSummary(partial.children)}${finalPreflightWarnings.length ? ` ${finalPreflightWarnings.join(" ")}` : ""}`;
                        const outputWarning = writeWorkflowAggregateOutput(workflowAggregateOutputPath, terminalSummary, producedChildOutputPaths);
                        const resultSummary = appendWorkflowOutputWarning(terminalSummary, outputWarning);
                        const receiptState = status.state === "complete" ? "complete" : status.state === "paused" ? "paused" : status.state === "stopped" ? "stopped" : "failed";
                        const terminalOutcome = workflowFailureTerminalOutcome(error, partial.children, usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)));
                        const receipt = terminalWorkflowReceipt(workflowRunId, receiptState, partial.children, workflowChildren, terminalOutcome, validHostStepNodes(status.workflowGraph), workflowResource?.provenance, workflowArgsDigest);
                        delete status.workflowReceiptPath;
                        let workflowReceipt;
                        try {
                            workflowReceipt = { path: writeWorkflowReceipt(asyncDir, receipt), receipt };
                            status.workflowReceiptPath = workflowReceipt.path;
                        }
                        catch (receiptError) {
                            appendWorkflowEvent({ type: "subagent.workflow.receipt_write_failed", error: `Failed to persist async workflow receipt: ${receiptError instanceof Error ? receiptError.message : String(receiptError)}` });
                        }
                        if (!writeWorkflowResult({ id: workflowRunId, runId: workflowRunId, toolCallId, agent: "workflow", mode: "workflow", success: status.state === "complete", state: status.state, summary: resultSummary, error: status.state === "complete" ? undefined : status.error, stopped: status.stopped, activityState: status.activityState, workflowChildren, ...(terminalOutcome ? { terminalOutcome } : {}), results: workflowResultChildren(partial.children, status, true), workflow: status.workflow, ...(workflowCapabilityCeiling ? { admissionCapabilityCeiling: workflowCapabilityCeiling } : {}), ...(workflowReceipt ? { workflowReceipt } : {}), asyncDir, cwd: workflowCwd, sessionId: currentSessionId, completionOwnerId, ...(requestParams.scheduleOrigin ? { scheduleOrigin: requestParams.scheduleOrigin } : {}), timestamp: Date.now(), durationMs: Date.now() - startedAt }))
                            return;
                        if (pendingResultPublication && !await pendingResultPublication)
                            return;
                        persist();
                        deps.refreshResultDelivery?.();
                        persistClosed = true;
                        appendWorkflowEvent({ type: "subagent.workflow.completed", state: status.state, ...(workflowArgsDigest ? { argsDigest: workflowArgsDigest } : {}), ...(terminalOutcome ? { terminalOutcome } : {}), ...(status.error ? { error: status.error } : {}), ...(status.activityState ? { activityState: status.activityState } : {}) });
                    }
                    finally {
                        // Idempotent cleanup only: a failed result/index write must not authorize terminal status.
                        try {
                            settleWorkflowSteerInbox();
                        }
                        catch (error) {
                            console.error(`Failed to close async workflow steer inbox '${asyncDir}':`, error);
                        }
                        persistClosed = true;
                        deps.state.workflowControllers?.delete(workflowRunId);
                        deps.state.workflowChildStops?.delete(workflowRunId);
                        deps.state.activeAsyncCapacity = workflowCapacity?.reconcile(new Set(deps.state.workflowControllers?.keys() ?? []))
                            ?? deps.state.activeAsyncCapacity;
                    }
                });
                return attachWorkflowMission(withRunFanoutBudget({
                    content: [{ type: "text", text: `${workflowPreflight ? `${formatWorkflowPreflight(workflowPreflight)}\n\n` : ""}${formatAsyncStartedMessage(`Async workflow [${workflowRunId}]`, ctx.hasUI === true)}` }],
                    details: { mode: "workflow", runId: workflowRunId, toolCallId, asyncId: workflowRunId, asyncDir, results: [], ...(workflowPreflight ? { preflight: workflowPreflight } : {}), workflow: status.workflow, workflowChildren: status.workflowChildren, chatProgress, ...(deps.state.activeAsyncCapacity ? { activeAsyncCapacity: deps.state.activeAsyncCapacity } : {}) },
                }, workflowFanoutBudget));
            }
            const { workflowScript: _workflowScript, args: _args, action: _action, agent: _agent, task: _task, resume: _resume, tasks: _tasks, chain: _chain, concurrency: _concurrency, async: _async, foregroundOnly: _foregroundOnly, clarify: _clarify, timeoutMs: _timeoutMs, maxRuntimeMs: _maxRuntimeMs, usageBudget: _usageBudget, chatProgress: _chatProgress, missionId: _missionId, mission: _mission, preflight: _preflight, globalConcurrencyLimit: _globalConcurrencyLimit, maxSubagentSpawnsPerRun: _maxSubagentSpawnsPerRun, ...workflowChildDefaults } = requestParams;
            const workflowOutput = typeof workflowChildDefaults.output === "string" || typeof workflowChildDefaults.output === "boolean" ? workflowChildDefaults.output : undefined;
            const configuredOutputBaseDir = resolveConfiguredSingleRunOutputBaseDir(deps);
            const workflowAggregateOutputPath = resolveSingleOutputPath(workflowOutput, ctx.cwd, workflowCwd, resolveSingleRunOutputBaseDir(deps, workflowArtifactsDir, foregroundWorkflowRunId));
            // A top-level artifact file: outside outputs/, where children save their reports, and
            // within artifact retention, which only removes top-level files.
            const workflowFullResultPath = path.join(workflowArtifactsDir, `${sanitizeRunPathSegment(foregroundWorkflowRunId)}_workflow-result.md`);
            const claimedOutputPaths = new Map();
            const childOutputOverrides = new Map();
            const childOutputClaimPaths = new Map();
            const producedChildOutputPaths = new Set();
            const workflowResults = [];
            const workflowChildRunIds = new Map();
            const runHostCommand = workflowHostCommandRunner({
                workflowCwd,
                artifactsDir: workflowArtifactsDir,
                workflowRunId: foregroundWorkflowRunId,
                claimedOutputPaths,
                producedOutputPaths: producedChildOutputPaths,
                ...(workflowResource ? { authorize: (key, params) => authorizeWorkflowResourceHost(workflowResource.permit, key, params.command) } : {}),
            });
            const workflowHost = delegatedWorkflowPermit
                ? undefined
                : workflowResource
                    ? workflowResource.authority.host ? runHostCommand : undefined
                    : publicExecution ? undefined : runHostCommand;
            const workflowHostSteps = new Map();
            let liveWorkflow = { trace: [], emits: [], console: [], ...(workflowResource ? { resource: workflowResource.provenance } : {}) };
            const childProgress = new Map();
            let activityTimer;
            let lastProgressAt = 0;
            let workflowProgressClosed = false;
            const workflowDeadlineAt = timeout === undefined ? undefined : Date.now() + timeout;
            const workflowCapabilityCeiling = intersectSubagentCapabilityCeilings(requestParams.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(resolveCurrentSessionId(ctx.sessionManager)));
            const sendWorkflowProgress = () => {
                if (workflowProgressClosed)
                    return;
                if (activityTimer)
                    clearTimeout(activityTimer);
                activityTimer = undefined;
                lastProgressAt = Date.now();
                const liveWorkflowChildren = workflowChildSummary({ parentToolCallId: _id, workflowRunId: foregroundWorkflowRunId, workflowState: "running", inventoryComplete: false, trace: liveWorkflow.trace, progress: childProgress });
                onUpdate?.(workflowProgressUpdate(foregroundWorkflowRunId, chatProgress, liveWorkflow, liveWorkflowChildren, workflowPreflight));
            };
            try {
                const workflow = await runWorkflowScript({
                    script: requestParams.workflowScript,
                    ...(workflowArgs ? { args: workflowArgs } : {}),
                    workflowRunId: foregroundWorkflowRunId,
                    processCwd: ctx.cwd,
                    ...(delegatedWorkflowPermit ? { oneUsePermit: { claim: (key) => claimWorkflowChildPermit(delegatedWorkflowPermit, foregroundWorkflowRunId, key) } } : {}),
                    globalConcurrencyLimit: requestParams.globalConcurrencyLimit ?? deps.config.globalConcurrencyLimit,
                    timeoutMs: timeout,
                    signal,
                    ...(workflowState ? { state: workflowState } : {}),
                    ...(workflowHost ? { host: workflowHost } : {}),
                    onHostStep: (hostStep) => {
                        workflowHostSteps.set(hostStep.id, { ...hostStep, ...(hostStep.freshness ? { freshness: { ...hostStep.freshness } } : {}) });
                    },
                    onTrace: (trace) => {
                        const projectedTrace = annotateWorkflowPreflightTrace(trace, workflowPreflight);
                        const preflightWarnings = workflowPreflightWarnings(workflowPreflight, trace);
                        liveWorkflow = { ...liveWorkflow, trace: projectedTrace, ...(preflightWarnings.length ? { preflightWarnings } : {}) };
                        for (const entry of trace) {
                            if (entry.operation === "run" && ["completed", "failed", "stopped", "detached"].includes(entry.state))
                                childProgress.delete(entry.key);
                        }
                        sendWorkflowProgress();
                    },
                    admit: async (calls, admissionSignal) => {
                        admitEnabledWorkflowChildren(calls);
                        await preflightWorkflowWorktrees({ workflowDefaults: workflowChildDefaults, defaultWorktree: deps.config.worktree, calls, ctxCwd: ctx.cwd, signal: admissionSignal, deadlineAt: workflowDeadlineAt });
                        const outputClaims = workflowChildOutputClaims({ ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, workflowRunId: foregroundWorkflowRunId, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: discoverWorkflowAgents, agents: workflowAgents, workflowAgentScope: workflowChildDefaults.agentScope, state: deps.state, claimedOutputPaths, entries: calls });
                        if (outputClaims.error)
                            throw new Error(outputClaims.error);
                        claimRunFanoutBatch(workflowFanoutBudget, calls.map(({ key }) => `workflow[${key}]`));
                        if (outputClaims.claims)
                            applyWorkflowChildOutputClaims(claimedOutputPaths, outputClaims.claims);
                        if (outputClaims.childClaims)
                            for (const [key, claimPath] of outputClaims.childClaims)
                                childOutputClaimPaths.set(key, claimPath);
                        if (outputClaims.overrides)
                            for (const [key, output] of outputClaims.overrides)
                                childOutputOverrides.set(key, output);
                    },
                    onEmit: (emits) => {
                        liveWorkflow = { ...liveWorkflow, emits };
                        sendWorkflowProgress();
                    },
                    launch: async (key, childParams, workflowSignal, admission) => {
                        if (delegatedWorkflowPermit && admission.batch)
                            throw new Error("Workflow child permit does not support runs.all.");
                        if (delegatedWorkflowPermit && childParams.resume !== undefined)
                            throw new Error("Workflow child permit does not support retained resume.");
                        if (delegatedWorkflowPermit && childParams.async === true)
                            throw new Error("Workflow child permit supports one foreground child only.");
                        if (workflowUsageBudget.budget && childParams.async === true)
                            return workflowChildResult(key, buildRequestedModeError(childParams, "workflow usageBudget does not support async runs.run launches."), childParams, deps.state);
                        const budgetState = usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults));
                        if (budgetState?.exhausted)
                            return workflowChildResult(key, buildRequestedModeError(childParams, usageBudgetExceededMessage(budgetState)), childParams, deps.state, { state: "partial", reason: "budget_exhausted" });
                        const childPhase = typeof childParams.phase === "string" && childParams.phase.trim() ? childParams.phase.trim() : undefined;
                        const childLabel = typeof childParams.label === "string" && childParams.label.trim() ? childParams.label.trim() : undefined;
                        recordMissionWorkflowChild(missionBinding, foregroundWorkflowRunId, key, {
                            status: "running",
                            ...(typeof childParams.agent === "string" && childParams.agent.trim() ? { agent: childParams.agent.trim() } : {}),
                            ...(childLabel ? { label: childLabel } : {}),
                            ...(childPhase ? { phase: childPhase } : {}),
                            heartbeat: { status: "running", ...(childPhase ? { phase: childPhase } : {}) },
                        });
                        let preparedChildParams;
                        const result = await runMissionWorkflowChild(missionBinding, foregroundWorkflowRunId, key, childPhase, () => {
                            const childRequest = bindMissionWorkflowChildAsyncLaunch({ ...prepareWorkflowChildLaunchParams({ workflowDefaults: workflowChildDefaults, childParams: delegatedWorkflowPermit ? { ...childParams, async: false } : childParams, parentWorkflowRunId: foregroundWorkflowRunId, workflowKey: key, ctxCwd: ctx.cwd, workflowCwd, artifactsDir: workflowArtifactsDir, aggregateOutputPath: workflowAggregateOutputPath, configuredOutputBaseDir, discoverAgents: discoverWorkflowAgents, agents: workflowAgents, workflowAgentScope: workflowChildDefaults.agentScope, outputOverride: childOutputOverrides.get(key), outputClaimPath: childOutputClaimPaths.get(key), options: { missionDetached: detachWorkflowChildMissions, suppressRoutineResultIntercom: chatProgress.mode === "live-card", runFanoutBudget: workflowFanoutBudget, parentDeadlineAt: workflowDeadlineAt, capabilityCeiling: workflowCapabilityCeiling } }), runFanoutAdmitted: admission.admitted }, missionBinding, deps.asyncByDefault, undefined, inheritedNestedRoute(deps)?.rootRunId);
                            preparedChildParams = childRequest;
                            if (workflowUsageBudget.budget)
                                workflowOwnedUsageBudgets.set(childRequest, workflowUsageBudget.budget);
                            if (delegatedWorkflowPermit) {
                                if (childRequest.async !== false)
                                    throw new Error("Workflow child permit supports one foreground child only.");
                                const childCwd = resolveRequestedCwd(workflowCwd, childRequest.cwd);
                                const childAgent = typeof childRequest.agent === "string"
                                    ? resolveAgentName(childRequest.agent, discoverWorkflowAgents(childCwd, resolveExecutionAgentScope(childRequest.agentScope)).agents).agent
                                    : undefined;
                                if (childAgent?.runner?.type === "external-cli" || childAgent?.runner?.type === "external-job")
                                    throw new Error("Workflow child permit supports native Pi children only.");
                                workflowPermitContexts.set(childRequest, { child: { permit: delegatedWorkflowPermit, workflowRunId: foregroundWorkflowRunId, childKey: key } });
                            }
                            workflowLaunchObservers.set(childRequest, (launch) => recordMissionWorkflowChild(missionBinding, foregroundWorkflowRunId, key, {
                                status: "running",
                                agent: launch.agent,
                                ...(launch.sessionFile ? { sessionPath: launch.sessionFile } : {}),
                            }));
                            return execute(randomUUID(), childRequest, workflowSignal, (update) => {
                                const progress = update.details.progress?.[0];
                                if (!progress)
                                    return;
                                if (onUpdate && !workflowProgressClosed) {
                                    if (progress.status === "running")
                                        childProgress.set(key, workflowChildProgress(progress));
                                    else
                                        childProgress.delete(key);
                                    if (!activityTimer) {
                                        const delay = 100 - (Date.now() - lastProgressAt);
                                        if (delay <= 0)
                                            sendWorkflowProgress();
                                        else
                                            activityTimer = setTimeout(sendWorkflowProgress, delay);
                                    }
                                }
                                const progressStatus = progress.status === "completed" ? "completed" : progress.status === "failed" ? "failed" : "running";
                                recordMissionWorkflowChild(missionBinding, foregroundWorkflowRunId, key, {
                                    status: progressStatus,
                                    heartbeat: { status: progressStatus, ...(childPhase ? { phase: childPhase } : {}) },
                                });
                            }, ctx, preserveActiveSession, workflowParentModel);
                        });
                        workflowResults.push(...result.details.results);
                        for (const childResult of result.details.results) {
                            if (childResult.savedOutputPath)
                                producedChildOutputPaths.add(resolveWorkflowHostOutputClaimPath(childResult.savedOutputPath));
                        }
                        if (result.details.asyncDir && missionBinding)
                            writeMissionAsyncBinding(result.details.asyncDir, missionBinding);
                        const child = workflowChildResult(key, result, preparedChildParams ?? childParams, deps.state);
                        if (child.runId)
                            workflowChildRunIds.set(key, child.runId);
                        const childStatus = missionWorkflowChildStatus(result);
                        recordMissionWorkflowChild(missionBinding, foregroundWorkflowRunId, key, {
                            status: childStatus,
                            ...(child.runId ? { runId: child.runId } : {}),
                            ...(result.details.results[0]?.agent ? { agent: result.details.results[0].agent } : {}),
                            ...(result.details.results[0]?.sessionFile ? { sessionPath: result.details.results[0].sessionFile } : {}),
                            artifactPaths: child.artifactPaths,
                            ...(["completed", "failed"].includes(childStatus) ? { completedAt: new Date().toISOString() } : {}),
                            heartbeat: { status: childStatus, ...(childPhase ? { phase: childPhase } : {}) },
                        });
                        return child;
                    },
                    status: async (keyOrRunId, workflowSignal) => workflowChildResult(keyOrRunId, await execute(randomUUID(), { action: "status", id: keyOrRunId }, workflowSignal, undefined, ctx, preserveActiveSession, workflowParentModel)),
                    resolveResume: (reference, _signal, index) => resolveWorkflowResume(reference, deps, ctx.sessionManager.getSessionFile() ?? null, index),
                    steer: (key, message, options, workflowSignal) => steerWorkflowChildByKey({ state: deps.state, workflowRunId: foregroundWorkflowRunId, key, message, options, signal: workflowSignal, resolveRunId: () => workflowChildRunIds.get(key) }),
                });
                const finalPreflightWarnings = workflowPreflightWarnings(workflowPreflight, workflow.trace, { settled: true });
                const finalPreflightTrace = annotateWorkflowPreflightTrace(workflow.trace, workflowPreflight);
                const workflowChildren = workflowChildSummary({ parentToolCallId: _id, workflowRunId: foregroundWorkflowRunId, workflowState: "completed", inventoryComplete: true, trace: workflow.trace, children: workflow.children });
                const receipt = terminalWorkflowReceipt(foregroundWorkflowRunId, "complete", workflow.children, workflowChildren, undefined, [...workflowHostSteps.values()], workflowResource?.provenance, workflowArgsDigest);
                const trace = finalPreflightTrace.map((entry) => ({ line: `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.durationMs !== undefined ? ` in ${entry.durationMs}ms` : ""}${entry.warning ? ` — ${entry.warning}` : ""}`, error: entry.error }));
                const runningSummary = workflowRunningChildrenSummary(workflow.children);
                const outputMappings = workflowOutputPathMappingSummary(workflow.children).trim();
                const displayText = formatWorkflowResultText({
                    head: [...(workflowPreflight ? [formatWorkflowPreflight(workflowPreflight)] : []), runningSummary ? `Workflow dispatch completed; ${runningSummary}` : "Workflow completed."],
                    script: [
                        `Return:\n${formatWorkflowValue(workflow.value)}`,
                        ...(workflow.emits.length > 0 ? [`Emitted:\n${workflow.emits.map(formatWorkflowValue).join("\n")}`] : []),
                        ...(workflow.console.length > 0 ? [`Console:\n${workflow.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`] : []),
                    ],
                    trace,
                    tail: [
                        ...(finalPreflightWarnings.length > 0 ? [formatWorkflowPreflightWarnings(finalPreflightWarnings)] : []),
                        ...(outputMappings ? [outputMappings] : []),
                    ],
                    maxOutput: requestParams.maxOutput,
                    aggregateOutputPath: workflowAggregateOutputPath,
                    fullResultPath: workflowFullResultPath,
                    producedChildOutputPaths,
                });
                return attachWorkflowMission(withRunFanoutBudget({
                    content: [{ type: "text", text: displayText }],
                    details: compactOptional({ mode: "workflow", runId: foregroundWorkflowRunId, results: workflowDetailsResults(workflow.children), ...(workflowPreflight ? { preflight: workflowPreflight } : {}), workflowChildren, totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { value: workflow.value, trace: finalPreflightTrace, emits: workflow.emits, console: workflow.console, ...(workflowArgsEvidence ?? {}), ...(workflowResource ? { resource: workflowResource.provenance } : {}), ...(finalPreflightWarnings.length ? { preflightWarnings: finalPreflightWarnings } : {}), receipt }, chatProgress }),
                }, workflowFanoutBudget));
            }
            catch (error) {
                const partial = error instanceof WorkflowScriptError ? error.partial : { trace: [], emits: [], console: [], children: [] };
                const text = workflowFailureMessage(error, foregroundWorkflowRunId, partial.children);
                const finalPreflightWarnings = workflowPreflightWarnings(workflowPreflight, partial.trace, { settled: true });
                const finalPreflightTrace = annotateWorkflowPreflightTrace(partial.trace, workflowPreflight);
                const trace = finalPreflightTrace.map((entry) => ({ line: `- ${entry.operation} ${entry.key}: ${entry.state}${entry.runId ? ` (${entry.runId})` : ""}${entry.warning ? ` — ${entry.warning}` : ""}`, error: entry.error }));
                const outputMappings = workflowOutputPathMappingSummary(partial.children).trim();
                const displayText = formatWorkflowResultText({
                    head: workflowPreflight ? [formatWorkflowPreflight(workflowPreflight)] : [],
                    script: [
                        `Workflow failed: ${text}`,
                        ...(partial.emits.length > 0 ? [`Emitted:\n${partial.emits.map(formatWorkflowValue).join("\n")}`] : []),
                        ...(partial.console.length > 0 ? [`Console:\n${partial.console.map((entry) => `[${entry.level}] ${entry.text}`).join("\n")}`] : []),
                    ],
                    trace,
                    tail: [
                        ...(finalPreflightWarnings.length > 0 ? [formatWorkflowPreflightWarnings(finalPreflightWarnings)] : []),
                        ...(outputMappings ? [outputMappings] : []),
                    ],
                    maxOutput: requestParams.maxOutput,
                    aggregateOutputPath: workflowAggregateOutputPath,
                    fullResultPath: workflowFullResultPath,
                    producedChildOutputPaths,
                });
                const workflowChildren = workflowChildSummary({ parentToolCallId: _id, workflowRunId: foregroundWorkflowRunId, workflowState: "failed", inventoryComplete: true, trace: partial.trace, children: partial.children });
                const terminalOutcome = workflowFailureTerminalOutcome(error, partial.children, usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)));
                const receipt = terminalWorkflowReceipt(foregroundWorkflowRunId, "failed", partial.children, workflowChildren, terminalOutcome, [...workflowHostSteps.values()], workflowResource?.provenance, workflowArgsDigest);
                return attachWorkflowMission(withRunFanoutBudget({
                    content: [{ type: "text", text: displayText }],
                    isError: true,
                    details: compactOptional({ mode: "workflow", runId: foregroundWorkflowRunId, results: workflowDetailsResults(partial.children), ...(workflowPreflight ? { preflight: workflowPreflight } : {}), workflowChildren, totalChildUsage: sumResultsUsage(workflowResults), totalCost: sumResultsCost(workflowResults), usageBudget: usageBudgetState(workflowUsageBudget.budget, sumResultsCost(workflowResults)), workflow: { trace: finalPreflightTrace, emits: partial.emits, console: partial.console, ...(error instanceof WorkflowScriptError && error.errorKind ? { failureKind: error.errorKind } : {}), ...(workflowArgsEvidence ?? {}), ...(workflowResource ? { resource: workflowResource.provenance } : {}), ...(finalPreflightWarnings.length ? { preflightWarnings: finalPreflightWarnings } : {}), receipt }, chatProgress }),
                }, workflowFanoutBudget));
            }
            finally {
                workflowProgressClosed = true;
                if (activityTimer)
                    clearTimeout(activityTimer);
                childProgress.clear();
            }
        }
        const directParams = requestParams;
        // With a machine, cwd names a directory on that machine: keep it out of every local path resolution.
        // Placement can also come from the agent's frontmatter or settings override, so the agent is resolved first (discovery is fingerprint-cached).
        const placedByAgent = () => {
            if (directParams.machine !== undefined || directParams.cwd === undefined || typeof directParams.agent !== "string")
                return false;
            try {
                return resolveAgentName(directParams.agent, deps.discoverAgents(ctx.cwd, resolveExecutionAgentScope(directParams.agentScope)).agents).agent?.machine !== undefined;
            }
            catch {
                return false; // Discovery errors surface from the launch path itself.
            }
        };
        const remotePlacement = directParams.action === undefined && (directParams.machine !== undefined || placedByAgent());
        const requestedCwd = remotePlacement ? undefined : directParams.cwd;
        const requestCwd = remotePlacement ? ctx.cwd : resolveRequestedCwd(ctx.cwd, directParams.cwd);
        const paramsWithResolvedCwd = directParams.cwd === undefined
            ? directParams
            : remotePlacement
                ? omitUndefinedProperties({ ...directParams, cwd: undefined, machineCwd: directParams.cwd })
                : { ...directParams, cwd: requestCwd };
        const action = paramsWithResolvedCwd.action;
        let requestSessionId = "";
        let requestPiSessionId;
        let requestParentModel;
        try {
            requestSessionId = resolveCurrentSessionId(ctx.sessionManager);
            requestPiSessionId = ctx.sessionManager.getSessionId() ?? undefined;
            requestParentModel = parentModelOverride !== undefined
                ? parentModelOverride ?? undefined
                : preserveActiveSession
                    ? normalizeParentModel(ctx.model)
                    : rememberParentModel(deps.state, requestSessionId, ctx.model);
        }
        catch (error) {
            if (action?.toLowerCase() !== "doctor" && action?.toLowerCase() !== "guide")
                throw error;
            requestParentModel = normalizeParentModel(ctx.model);
        }
        if (action) {
            if (action === "worktree.cleanup") {
                if (deps.allowMutatingManagementActions === false) {
                    return { content: [{ type: "text", text: "Action 'worktree.cleanup' is not available from child-safe subagent fanout mode." }], isError: true, details: { mode: "management", results: [] } };
                }
                if (paramsWithResolvedCwd.mode !== "plan") {
                    return { content: [{ type: "text", text: "worktree.cleanup currently supports mode='plan' only; apply/removal is not available yet." }], isError: true, details: { mode: "management", results: [] } };
                }
                if (paramsWithResolvedCwd.planId !== undefined) {
                    return { content: [{ type: "text", text: "worktree.cleanup plan mode does not accept planId; apply is not available yet." }], isError: true, details: { mode: "management", results: [] } };
                }
                try {
                    const created = createWorktreeCleanupPlan({
                        repo: paramsWithResolvedCwd.repo?.trim()
                            ? path.isAbsolute(paramsWithResolvedCwd.repo) ? paramsWithResolvedCwd.repo : path.resolve(requestCwd, paramsWithResolvedCwd.repo)
                            : requestCwd,
                        ...(paramsWithResolvedCwd.handoffPath ? { handoffPath: path.isAbsolute(paramsWithResolvedCwd.handoffPath) ? paramsWithResolvedCwd.handoffPath : path.resolve(requestCwd, paramsWithResolvedCwd.handoffPath) } : {}),
                        ...(deps.config.worktreeBaseDir ? { worktreeBaseDir: deps.config.worktreeBaseDir } : {}),
                        foregroundRunOwnership: (runId) => {
                            if (deps.state.foregroundControls.has(runId))
                                return "active";
                            const remembered = deps.state.foregroundRuns?.get(runId);
                            if (!remembered || remembered.children.length === 0 || remembered.children.some((child) => child.status === "detached"))
                                return "unknown";
                            return "terminal";
                        },
                    });
                    return { content: [{ type: "text", text: formatWorktreeCleanupPlan(created) }], details: { mode: "management", results: [] } };
                }
                catch (error) {
                    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
                }
            }
            if (action === "worktree.discard") {
                if (deps.allowMutatingManagementActions === false) {
                    return { content: [{ type: "text", text: "Action 'worktree.discard' is not available from child-safe subagent fanout mode." }], isError: true, details: { mode: "management", results: [] } };
                }
                if (!paramsWithResolvedCwd.handoffPath?.trim()) {
                    return { content: [{ type: "text", text: "worktree.discard requires handoffPath from parallelHandoff.path or async status." }], isError: true, details: { mode: "management", results: [] } };
                }
                const decision = resolveAuthorityDecision({ action: "discardWorktree", ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
                if (decision === "forbid") {
                    return { content: [{ type: "text", text: "Authority policy forbids worktree discard." }], isError: true, details: { mode: "management", results: [] } };
                }
                let confirmed = decision === "auto";
                if (decision === "confirm") {
                    if (!ctx.hasUI)
                        return { content: [{ type: "text", text: "Authority policy requires user confirmation for worktree discard, but this session has no interactive UI. Preserved worktrees were not changed." }], isError: true, details: { mode: "management", results: [] } };
                    confirmed = await ctx.ui.confirm("Discard preserved subagent worktrees?", `This permanently removes preserved worktrees and temporary branches recorded in:\n${paramsWithResolvedCwd.handoffPath}`);
                }
                if (!confirmed)
                    return { content: [{ type: "text", text: "Worktree discard canceled; preserved worktrees were not changed." }], details: { mode: "management", results: [] } };
                try {
                    const manifestPath = path.isAbsolute(paramsWithResolvedCwd.handoffPath) ? paramsWithResolvedCwd.handoffPath : path.resolve(requestCwd, paramsWithResolvedCwd.handoffPath);
                    const discarded = await withWorktreeTransaction(() => discardPreservedWorktrees(manifestPath, { kind: decision === "confirm" ? "confirmed" : "policy", ...(deps.config.authorityPolicy ? { policy: deps.config.authorityPolicy } : {}) }));
                    return { content: [{ type: "text", text: discarded.text }], details: { mode: "management", results: [] } };
                }
                catch (error) {
                    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
                }
            }
            if (action === "lane.status" || action === "lane.recordMerge" || action === "lane.recordSupersession") {
                if (action !== "lane.status" && deps.allowMutatingManagementActions === false) {
                    return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
                }
                const laneId = paramsWithResolvedCwd.laneId?.trim();
                if (!laneId)
                    return { content: [{ type: "text", text: `${action} requires laneId.` }], isError: true, details: { mode: "management", results: [] } };
                const handoffPath = paramsWithResolvedCwd.handoffPath?.trim();
                if (!handoffPath)
                    return { content: [{ type: "text", text: `${action} requires handoffPath for the existing parallel handoff manifest.` }], isError: true, details: { mode: "management", results: [] } };
                const manifestPath = path.isAbsolute(handoffPath) ? handoffPath : path.resolve(requestCwd, handoffPath);
                try {
                    if (action === "lane.status") {
                        let manifest;
                        try {
                            manifest = readParallelHandoffManifest(manifestPath);
                        }
                        catch {
                            manifest = undefined;
                        }
                        if (manifest && manifest.runId !== laneId)
                            throw new Error(`Lane '${laneId}' does not match manifest run '${manifest.runId}'.`);
                        return { content: [{ type: "text", text: formatStoredParallelHandoffCleanup(manifestPath, manifest) }], details: { mode: "management", results: [] } };
                    }
                    const recorded = action === "lane.recordMerge"
                        ? recordParallelHandoffMerge({ manifestPath, laneId, merge: paramsWithResolvedCwd.merge })
                        : recordParallelHandoffSupersession({ manifestPath, laneId, supersession: paramsWithResolvedCwd.supersession });
                    return { content: [{ type: "text", text: recorded.text }], details: { mode: "management", results: [], parallelHandoff: recorded.reference } };
                }
                catch (error) {
                    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true, details: { mode: "management", results: [] } };
                }
            }
            const policyAction = action === "stop" ? "stopRun" : action === "steer" ? "steerRun" : action === "schedule.create" ? "scheduleCreate" : action === "inspector.open" ? "inspectorOpen" : action === "project.open" ? "projectOpen" : undefined;
            if (policyAction) {
                // Child-safe mode is a hard capability boundary; the policy is an operator
                // preference. Refuse first, so the gate never prompts for an action that is
                // going to be rejected anyway and never masks the more specific reason.
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
                }
                const decision = resolveAuthorityDecision({ action: policyAction, ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
                if (decision === "forbid") {
                    return { content: [{ type: "text", text: `Authority policy forbids action '${action}'.` }], isError: true, details: { mode: "management", results: [] } };
                }
                if (decision === "confirm") {
                    if (!ctx.hasUI)
                        return { content: [{ type: "text", text: `Authority policy requires user confirmation for action '${action}', but this session has no interactive UI.` }], isError: true, details: { mode: "management", results: [] } };
                    const confirmed = await ctx.ui.confirm(`Authorize subagent ${action}?`, `Authority policy requires confirmation before '${action}'.`);
                    if (!confirmed)
                        return { content: [{ type: "text", text: `Action '${action}' canceled; authority was not granted.` }], details: { mode: "management", results: [] } };
                }
            }
            if (HERDR_PROJECT_PANE_ACTIONS.includes(action)) {
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
                }
                deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                return handleHerdrProjectPaneAction(action, paramsWithResolvedCwd, { cwd: requestCwd, state: deps.state, signal });
            }
            if (INSPECTOR_ACTIONS.includes(action)) {
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return { content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }], isError: true, details: { mode: "management", results: [] } };
                }
                deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                return handleInspectorAction(action, paramsWithResolvedCwd, {
                    state: deps.state,
                    cwd: requestCwd,
                    ...(deps.config.missions ? { missions: deps.config.missions } : {}),
                    ...(deps.config.authorityPolicy ? { authorityPolicy: deps.config.authorityPolicy } : {}),
                    plugins: getInspectorPlugins(deps.pi),
                    signal,
                });
            }
            if (MISSION_ACTIONS.includes(action)) {
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return {
                        content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                const currentSessionId = deps.state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined;
                return handleMissionAction(action, paramsWithResolvedCwd, {
                    cwd: requestCwd,
                    ...(deps.config.missions ? { config: deps.config.missions } : {}),
                    ...(currentSessionId ? { currentSessionId } : {}),
                });
            }
            if (WATCHDOG_TOOL_ACTIONS.includes(action)) {
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return {
                        content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                return handleWatchdogToolAction(action, paramsWithResolvedCwd, ctx, deps.watchdog);
            }
            if (action === "refine" || action === "refine.show" || action === "refine.rollback") {
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return {
                        content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                return handleRefinementAction(action, paramsWithResolvedCwd, {
                    cwd: requestCwd,
                    state: deps.state,
                    signal,
                    launchProposalChild: (task, outputSchema, proposalSignal) => execute(randomUUID(), {
                        agent: "reviewer",
                        task,
                        context: "fresh",
                        async: false,
                        artifacts: false,
                        outputSchema,
                        toolBudget: { hard: 1, block: ["write", "edit", "bash"] },
                    }, proposalSignal, undefined, ctx, true),
                });
            }
            if (action === "grant-spawn-budget") {
                if (deps.allowMutatingManagementActions === false || !ctx.hasUI) {
                    return {
                        content: [{ type: "text", text: "Action 'grant-spawn-budget' is available only from the root interactive parent session." }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                if (!deps.state.currentSessionId) {
                    return {
                        content: [{ type: "text", text: "Action 'grant-spawn-budget' requires an active parent session id." }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                if (hasActiveSubagentChildren(deps.state)) {
                    const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
                    return {
                        content: [{ type: "text", text: "Spawn budget grants are rejected while current-session children are queued or running. Wait for them to settle, then retry the explicit grant." }],
                        isError: true,
                        details: { mode: "management", results: [], spawnBudget },
                    };
                }
                const sessionId = deps.state.currentSessionId;
                const additional = paramsWithResolvedCwd.additional ?? Number.NaN;
                const preview = preflightSpawnBudgetGrant(deps.state, deps.config, sessionId, additional);
                if (preview.error) {
                    return {
                        content: [{ type: "text", text: preview.error }],
                        isError: true,
                        details: { mode: "management", results: [], spawnBudget: preview.snapshot },
                    };
                }
                const authority = resolveAuthorityDecision({ action: "spawnBudgetGrant", ...(deps.config.authorityPolicy === undefined ? {} : { policy: deps.config.authorityPolicy }) });
                if (authority === "forbid") {
                    return {
                        content: [{ type: "text", text: "Authority policy forbids spawn budget grants." }],
                        isError: true,
                        details: { mode: "management", results: [], spawnBudget: preview.snapshot },
                    };
                }
                const confirmed = authority === "auto" || await ctx.ui.confirm("Grant subagent spawn budget?", `Add ${additional} launches to this logical session?\n\n${formatSpawnBudget(preview.snapshot)}\n\nUsage is not reset. Compaction keeps the same budget; a new parent session starts a fresh one.`);
                if (!confirmed) {
                    return {
                        content: [{ type: "text", text: "Spawn budget grant canceled; no capacity was added." }],
                        details: { mode: "management", results: [], spawnBudget: preview.snapshot },
                    };
                }
                const currentBudget = getSpawnBudgetSnapshot(deps.state, deps.config, deps.state.currentSessionId);
                if (resolveCurrentSessionId(ctx.sessionManager) !== sessionId
                    || hasActiveSubagentChildren(deps.state)
                    || currentBudget.used !== preview.snapshot.used
                    || currentBudget.granted !== preview.snapshot.granted) {
                    return {
                        content: [{ type: "text", text: "Spawn budget grant was not applied because the session, budget, or active-child state changed while confirmation was open." }],
                        isError: true,
                        details: { mode: "management", results: [], spawnBudget: currentBudget },
                    };
                }
                const granted = grantSpawnBudget(deps.state, deps.config, sessionId, additional);
                return {
                    content: [{ type: "text", text: granted.error ?? `Spawn budget grant applied: +${additional}. ${formatSpawnBudget(granted.snapshot)}` }],
                    ...(granted.error ? { isError: true } : {}),
                    details: { mode: "management", results: [], spawnBudget: granted.snapshot },
                };
            }
            if (action === "guide") {
                try {
                    const guide = readSubagentGuide(paramsWithResolvedCwd.topic);
                    const notice = paramsWithResolvedCwd.topic === "tool-reference" ? disabledFeatureNotice(disabledFeatures) : undefined;
                    return {
                        content: [{ type: "text", text: notice ? `${notice}\n\n${guide}` : guide }],
                        details: { mode: "management", results: [] },
                    };
                }
                catch (error) {
                    return {
                        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
            }
            if (action === "children.list") {
                deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                const children = listRetainedChildren(DIRS.async, deps.state.currentSessionId);
                return {
                    content: [{ type: "text", text: formatRetainedChildren(children) }],
                    details: { mode: "management", results: [] },
                };
            }
            if (action === "doctor") {
                let currentSessionFile = null;
                let currentSessionId = deps.state.currentSessionId;
                let sessionError;
                try {
                    currentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
                    currentSessionId = ctx.sessionManager.getSessionId();
                }
                catch (error) {
                    sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                }
                let orchestratorTarget;
                try {
                    orchestratorTarget = resolveIntercomSessionTarget(deps.childRuntime?.intercomSessionName ?? deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
                }
                catch (error) {
                    if (!sessionError)
                        sessionError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                }
                const spawnBudget = getSpawnBudgetSnapshot(deps.state, deps.config, currentSessionId);
                const activeAsyncCapacity = currentSessionId
                    ? getActiveAsyncCapacitySnapshot(currentSessionId, resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession), { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) })
                    : { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession) ?? 0 };
                deps.state.activeAsyncCapacity = activeAsyncCapacity;
                return {
                    content: [{
                            type: "text",
                            text: buildDoctorReport(omitUndefinedProperties({
                                cwd: requestCwd,
                                config: deps.config,
                                state: deps.state,
                                context: paramsWithResolvedCwd.context === "profile" ? undefined : paramsWithResolvedCwd.context,
                                requestedSessionDir: paramsWithResolvedCwd.sessionDir,
                                currentSessionFile,
                                currentSessionId,
                                orchestratorTarget,
                                sessionError,
                                expandTilde: deps.expandTilde,
                            })),
                        }],
                    details: { mode: "management", results: [], spawnBudget, activeAsyncCapacity },
                };
            }
            if (action === "status" || action === "debug.run") {
                if (!preserveActiveSession)
                    deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                const targetRunId = paramsWithResolvedCwd.id ?? paramsWithResolvedCwd.runId;
                const hasDirectoryTarget = Boolean(paramsWithResolvedCwd.dir);
                const targetLabel = action === "debug.run" ? "Debug run" : formatStatusTargetLabel(paramsWithResolvedCwd, targetRunId);
                const withBudget = (result) => {
                    const budgeted = withSpawnBudgetStatus(result, deps.state, deps.config, deps.state.currentSessionId);
                    return {
                        ...budgeted,
                        content: budgeted.content.map((item, index) => index === 0 && item.type === "text"
                            ? { ...item, text: `${targetLabel}\n${item.text}` }
                            : item),
                    };
                };
                const nestedScope = nestedResolutionScopeForExecutor(deps);
                const sessionRoots = trustedSessionRootsForStatus(ctx, deps);
                if (action === "debug.run") {
                    if (!targetRunId && !hasDirectoryTarget) {
                        return withBudget({ content: [{ type: "text", text: "action='debug.run' requires id, runId, or dir." }], isError: true, details: { mode: "management", results: [] } });
                    }
                    if (paramsWithResolvedCwd.view) {
                        return withBudget({ content: [{ type: "text", text: "action='debug.run' does not support status views." }], isError: true, details: { mode: "management", results: [] } });
                    }
                    return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots, abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) })));
                }
                if (paramsWithResolvedCwd.view === "fleet" || paramsWithResolvedCwd.view === "transcript") {
                    return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots, abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) })));
                }
                if (targetRunId) {
                    try {
                        const resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedScope }));
                        if (resolved?.kind === "foreground") {
                            const foreground = getForegroundControl(deps.state, resolved.id);
                            if (foreground) {
                                return withBudget(foregroundStatusResult(foreground));
                            }
                        }
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return withBudget({ content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } });
                    }
                }
                else if (!hasDirectoryTarget) {
                    const foreground = getForegroundControl(deps.state, undefined);
                    if (foreground)
                        return withBudget(foregroundStatusResult(foreground));
                }
                return withBudget(inspectSubagentStatus(paramsWithResolvedCwd, omitUndefinedProperties({ state: deps.state, nested: nestedScope, sessionRoots, abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) })));
            }
            if (action === "resume") {
                return resumeAsyncRun(omitUndefinedProperties({
                    params: paramsWithResolvedCwd,
                    requestCwd,
                    ctx,
                    deps,
                    parentModel: requestParentModel,
                    signal,
                    ...(workflowLaunchObserver ? { onLaunch: (launch) => {
                            workflowLaunchObservers.delete(params);
                            workflowLaunchObserver(launch);
                        } } : {}),
                }));
            }
            if (action === "steer") {
                if (paramsWithResolvedCwd.mode !== undefined && resolveSteerDeliveryMode(paramsWithResolvedCwd.mode) === undefined) {
                    return { content: [{ type: "text", text: "action='steer' mode must be 'steer', 'follow_up', or 'auto'." }], isError: true, details: { mode: "management", results: [] } };
                }
                deps.state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
                const message = (paramsWithResolvedCwd.message ?? paramsWithResolvedCwd.task ?? "").trim();
                if (!message)
                    return { content: [{ type: "text", text: "action='steer' requires message." }], isError: true, details: { mode: "management", results: [] } };
                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
                if (paramsWithResolvedCwd.dir) {
                    try {
                        const location = resolveAsyncRunLocation(paramsWithResolvedCwd, DIRS.async, DIRS.results);
                        const runId = location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir);
                        const directoryStatus = location.asyncDir ? readStatus(location.asyncDir) : null;
                        if (directoryStatus?.mode === "workflow") {
                            return steerWorkflowRun({ state: deps.state, runId, asyncDir: location.asyncDir, message, mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode), index: paramsWithResolvedCwd.index, signal });
                        }
                        if (location.asyncDir) {
                            const unsupported = externalRunnerControlError(location.asyncDir, "steer");
                            if (unsupported)
                                return unsupported;
                        }
                        return steerAsyncRun(compactOptional({
                            state: deps.state,
                            findPendingAsks: deps.findPendingAsks,
                            runId,
                            message,
                            mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode),
                            index: paramsWithResolvedCwd.index,
                            kill: deps.kill,
                            location,
                            signal,
                            ...(paramsWithResolvedCwd.steeringRecovery === false
                                ? {}
                                : {
                                    recover: ({ absoluteDeadlineAt, ...limits }) => resumeAsyncRun(omitUndefinedProperties({ params: { ...limits, action: "resume", id: runId, message }, requestCwd, ctx, deps, parentModel: requestParentModel, absoluteDeadlineAt })),
                                }),
                        }));
                    }
                    catch (error) {
                        const text = error instanceof Error ? error.message : String(error);
                        return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
                    }
                }
                if (!targetRunId)
                    return { content: [{ type: "text", text: "action='steer' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
                let resolved;
                try {
                    resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
                }
                catch (error) {
                    const text = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
                }
                if (resolved?.kind === "nested")
                    return steerNestedRun(omitUndefinedProperties({ target: resolved, message, mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode), index: paramsWithResolvedCwd.index, signal }));
                if (resolved?.kind === "foreground") {
                    const route = resolveWorkflowForegroundSteeringTarget({ state: deps.state, childRunId: resolved.id, asyncDirRoot: DIRS.async });
                    if (!route.ok)
                        return { content: [{ type: "text", text: route.message }], isError: true, details: { mode: "management", results: [] } };
                    return steerWorkflowForegroundTarget({ target: route.target, message, mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode), index: paramsWithResolvedCwd.index });
                }
                if (resolved?.kind !== "async")
                    return { content: [{ type: "text", text: `No async run found for '${targetRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
                const resolvedStatus = resolved.location.asyncDir ? readStatus(resolved.location.asyncDir) : null;
                if (resolvedStatus?.mode === "workflow") {
                    return steerWorkflowRun({ state: deps.state, runId: resolved.id, asyncDir: resolved.location.asyncDir, message, mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode), index: paramsWithResolvedCwd.index, signal });
                }
                if (resolved.location.asyncDir) {
                    const unsupported = externalRunnerControlError(resolved.location.asyncDir, "steer");
                    if (unsupported)
                        return unsupported;
                }
                return steerAsyncRun(compactOptional({
                    state: deps.state,
                    findPendingAsks: deps.findPendingAsks,
                    runId: resolved.id,
                    message,
                    mode: resolveSteerDeliveryMode(paramsWithResolvedCwd.mode),
                    index: paramsWithResolvedCwd.index,
                    kill: deps.kill,
                    location: resolved.location,
                    signal,
                    ...(paramsWithResolvedCwd.steeringRecovery === false
                        ? {}
                        : {
                            recover: ({ absoluteDeadlineAt, ...limits }) => resumeAsyncRun(omitUndefinedProperties({
                                params: { ...limits, action: "resume", id: resolved.id, message },
                                requestCwd,
                                ctx,
                                deps,
                                parentModel: requestParentModel,
                                absoluteDeadlineAt,
                            })),
                        }),
                }));
            }
            if (action === "append-step") {
                return appendStepToAsyncChain(omitUndefinedProperties({ params: paramsWithResolvedCwd, requestCwd, ctx, deps, parentModel: requestParentModel }));
            }
            if (action.startsWith("schedule.")) {
                if (!isScheduledRunAction(action)) {
                    return { content: [{ type: "text", text: unknownSubagentActionMessage(action, disabledFeatures) }], isError: true, details: { mode: "management", results: [] } };
                }
                if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                    return {
                        content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                if (!deps.handleScheduledRunAction) {
                    return {
                        content: [{ type: "text", text: `Action '${action}' is not available in this subagent context.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                return deps.handleScheduledRunAction(paramsWithResolvedCwd, ctx);
            }
            if (deps.allowMutatingManagementActions === false && MUTATING_MANAGEMENT_ACTIONS.has(action)) {
                return {
                    content: [{ type: "text", text: `Action '${action}' is not available from child-safe subagent fanout mode.` }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            if (action === "dismiss") {
                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
                if (!targetRunId)
                    return { content: [{ type: "text", text: "action='dismiss' requires id." }], isError: true, details: { mode: "management", results: [] } };
                let resolved;
                try {
                    resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
                }
                if (resolved?.kind !== "async") {
                    return { content: [{ type: "text", text: `Run '${targetRunId}' is not a recovered workflow.` }], isError: true, details: { mode: "management", results: [] } };
                }
                return dismissRecoveredWorkflow(deps.state, resolved.location);
            }
            if (action === "stop") {
                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
                // Whole-workflow stops reach stopAsyncRun below, which stops a live workflow in-process.
                const workflowRunId = targetRunId && paramsWithResolvedCwd.childId !== undefined ? resolveLiveWorkflowRunId(deps, targetRunId) : undefined;
                if (workflowRunId && paramsWithResolvedCwd.childId !== undefined) {
                    const stopChild = deps.state.workflowChildStops?.get(workflowRunId);
                    const asyncJob = deps.state.asyncJobs.get(workflowRunId);
                    if (!asyncJob?.asyncDir)
                        return { content: [{ type: "text", text: `Status file not found for async workflow '${workflowRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
                    const status = readStatus(asyncJob.asyncDir);
                    if (!status)
                        return { content: [{ type: "text", text: `Status file not found for async workflow '${workflowRunId}'.` }], isError: true, details: { mode: "management", results: [] } };
                    const resolution = resolveAsyncStatusChild(status, paramsWithResolvedCwd.childId);
                    if (!resolution.ok)
                        return { content: [{ type: "text", text: resolution.message }], isError: true, details: { mode: "management", results: [] } };
                    if (!isStoppableAsyncStatusStep(resolution.child.step))
                        return { content: [{ type: "text", text: `Child '${paramsWithResolvedCwd.childId}' in async run '${workflowRunId}' is ${resolution.child.step.status}; stop only supports pending or running children.` }], isError: true, details: { mode: "management", results: [] } };
                    if (!stopChild)
                        return { content: [{ type: "text", text: `Workflow ${workflowRunId} child stop is unavailable in this extension runtime.` }], isError: true, details: { mode: "management", results: [] } };
                    if (!stopChild(resolution.child.id, `Workflow child '${resolution.child.id}' stopped.`))
                        return { content: [{ type: "text", text: `Child '${paramsWithResolvedCwd.childId}' in workflow ${workflowRunId} is not available to stop.` }], isError: true, details: { mode: "management", results: [] } };
                    try {
                        fs.appendFileSync(path.join(asyncJob.asyncDir, "events.jsonl"), `${JSON.stringify({
                            type: "subagent.child-status",
                            version: 1,
                            runId: workflowRunId,
                            childId: resolution.child.id,
                            status: "stopping",
                            ts: Date.now(),
                            reason: "subagent-action",
                            source: "async",
                            stepIndex: resolution.child.index,
                            agent: resolution.child.step.agent,
                            ...(resolution.child.step.runId ? { childRunId: resolution.child.step.runId } : {}),
                            ...(resolution.child.step.workflowKey ? { workflowKey: resolution.child.step.workflowKey } : {}),
                            ...(resolution.child.step.phase ? { phase: resolution.child.step.phase } : {}),
                            ...(resolution.child.step.label ? { label: resolution.child.step.label } : {}),
                        })}\n`, "utf-8");
                    }
                    catch (error) {
                        console.error(`Failed to append child status event for workflow ${workflowRunId}:`, error);
                    }
                    return { content: [{ type: "text", text: `Stop requested for child ${resolution.child.id} in async workflow ${workflowRunId}.` }], details: { mode: "management", results: [] } };
                }
                let resolved;
                if (paramsWithResolvedCwd.dir) {
                    try {
                        const location = resolveAsyncRunLocation(paramsWithResolvedCwd, DIRS.async, DIRS.results);
                        const stopResult = stopAsyncRun(deps.state, location.resolvedId ?? targetRunId ?? path.basename(location.asyncDir ?? paramsWithResolvedCwd.dir), deps.kill, location, paramsWithResolvedCwd.childId);
                        return stopResult ?? { content: [{ type: "text", text: `No running or queued async run was found for '${targetRunId ?? paramsWithResolvedCwd.dir}'.` }], isError: true, details: { mode: "management", results: [] } };
                    }
                    catch (error) {
                        const text = error instanceof Error ? error.message : String(error);
                        return { content: [{ type: "text", text }], isError: true, details: { mode: "management", results: [] } };
                    }
                }
                if (!targetRunId)
                    return { content: [{ type: "text", text: "action='stop' requires id or dir." }], isError: true, details: { mode: "management", results: [] } };
                try {
                    resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
                }
                if (resolved?.kind === "nested")
                    return { content: [{ type: "text", text: "action='stop' supports current-session top-level async runs only." }], isError: true, details: { mode: "management", results: [] } };
                if (resolved?.kind === "foreground")
                    return { content: [{ type: "text", text: "action='stop' supports async runs only. Use action='interrupt' for foreground runs." }], isError: true, details: { mode: "management", results: [] } };
                const stopResult = stopAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId, deps.kill, resolved?.kind === "async" ? resolved.location : undefined, paramsWithResolvedCwd.childId);
                if (stopResult)
                    return stopResult;
                return {
                    content: [{ type: "text", text: "No stoppable async run found in this session." }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            if (action === "interrupt") {
                const targetRunId = paramsWithResolvedCwd.runId ?? paramsWithResolvedCwd.id;
                let resolved;
                if (targetRunId) {
                    try {
                        resolved = resolveSubagentRunId(targetRunId, omitUndefinedProperties({ state: deps.state, nested: nestedResolutionScopeForExecutor(deps) }));
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        return { content: [{ type: "text", text: message }], isError: true, details: { mode: "management", results: [] } };
                    }
                }
                if (resolved?.kind === "nested")
                    return interruptNestedRun(resolved);
                const foreground = getForegroundControl(deps.state, resolved?.kind === "foreground" ? resolved.id : targetRunId);
                if (foreground?.interrupt) {
                    const interrupted = foreground.interrupt();
                    if (interrupted) {
                        foreground.updatedAt = Date.now();
                        delete foreground.currentActivityState;
                        return {
                            content: [{ type: "text", text: `Interrupt requested for foreground run ${foreground.runId}.` }],
                            details: { mode: "management", results: [] },
                        };
                    }
                    return {
                        content: [{ type: "text", text: `Foreground run ${foreground.runId} has no active child step to interrupt.` }],
                        isError: true,
                        details: { mode: "management", results: [] },
                    };
                }
                const asyncInterruptResult = interruptAsyncRun(deps.state, resolved?.kind === "async" ? resolved.id : targetRunId, deps.kill, resolved?.kind === "async" ? resolved.location : undefined);
                if (asyncInterruptResult)
                    return asyncInterruptResult;
                return {
                    content: [{ type: "text", text: "No interrupt-capable run found in this session." }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            if (!SUBAGENT_ACTIONS.includes(action)) {
                return {
                    content: [{ type: "text", text: unknownSubagentActionMessage(action, disabledFeatures) }],
                    isError: true,
                    details: { mode: "management", results: [] },
                };
            }
            return handleManagementAction(action, paramsWithResolvedCwd, {
                ...ctx,
                cwd: requestCwd,
                config: deps.config,
                currentSessionId: deps.state.currentSessionId ?? ctx.sessionManager.getSessionId() ?? undefined,
                discoverAgentsAll: deps.discoverAgentsAll,
                runtimeAgentOwner: deps.pi,
                onAgentsChanged: deps.onAgentsChanged,
            });
        }
        const { blocked, depth, maxDepth } = checkSubagentDepth(deps.config.maxSubagentDepth, deps.childRuntime);
        if (blocked) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Nested subagent call blocked (depth=${depth}, max=${maxDepth}). ` +
                            "You are running at the maximum subagent nesting depth. " +
                            "Complete your current task directly without delegating to further subagents.",
                    },
                ],
                isError: true,
                details: { mode: "single", results: [] },
            };
        }
        const normalized = normalizeRepeatedParallelCounts(paramsWithResolvedCwd);
        if (normalized.error)
            return normalized.error;
        const normalizedParams = normalized.params;
        const outputSchemaError = validateLaunchOutputSchemaOverrides(normalizedParams);
        if (outputSchemaError)
            return buildRequestedModeError(normalizedParams, outputSchemaError);
        let effectiveParams = applyForceTopLevelAsyncOverride(normalizedParams, depth, deps.config.forceTopLevelAsync === true);
        const runToolBudget = resolveToolBudget(effectiveParams.toolBudget, "toolBudget", allowZeroToolBudget ? { minimumHard: 0 } : undefined);
        if (runToolBudget.error)
            return buildRequestedModeError(effectiveParams, runToolBudget.error);
        const configToolBudget = resolveToolBudget(deps.config.toolBudget, "config.toolBudget");
        if (configToolBudget.error)
            return buildRequestedModeError(effectiveParams, configToolBudget.error);
        const usageBudget = validateUsageBudgetConfig(effectiveParams.usageBudget ?? deps.config.usageBudget, effectiveParams.usageBudget ? "usageBudget" : "config.usageBudget");
        if (usageBudget.error)
            return buildRequestedModeError(effectiveParams, usageBudget.error);
        const scope = resolveExecutionAgentScope(effectiveParams.agentScope);
        const effectiveCwd = effectiveParams.cwd ?? ctx.cwd;
        const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
        const discovered = deps.discoverAgents(effectiveCwd, scope, requestParentModel?.provider);
        const discoveredAgents = discovered.agents;
        const unknownAgentDiagnosticContext = diagnosticContextFromDiscovery(discovered, effectiveCwd, scope);
        const canonicalParams = canonicalizeExecutionParams(effectiveParams, discoveredAgents, discovered.agentDiagnostics, unknownAgentDiagnosticContext);
        if (canonicalParams.error)
            return buildRequestedModeError(effectiveParams, canonicalParams.error);
        effectiveParams = canonicalParams.params;
        if (effectiveParams.worktree === undefined && deps.config.worktree !== undefined) {
            effectiveParams = { ...effectiveParams, worktree: deps.config.worktree };
        }
        const modelScope = discovered.modelScope;
        effectiveParams = applySingleAgentLaunchDefaults(effectiveParams, discoveredAgents);
        // The gate shorthand, an explicit acceptance.verify list, and an agent's
        // defaultAcceptance all normalize to verify commands, and the agent's
        // frontmatter outputSchema has been merged by now, so this one check keeps
        // a run to a single structured-output source regardless of spelling.
        const typedVerifyConflict = describeTypedVerifyOutputSchemaConflict(effectiveParams, params);
        if (typedVerifyConflict)
            return buildRequestedModeError(effectiveParams, typedVerifyConflict);
        // An agent-level defaultContext is a preference, unlike an explicit request.
        // Prefer fork only when the parent session is persisted and has a current leaf;
        // otherwise use fresh immediately instead of launching a guaranteed-to-fail fork.
        // Explicit context:"fork" remains strict.
        const contextPolicyResult = resolveAgentDefaultContextPolicy(effectiveParams, discoveredAgents, deps.config.defaultSubagentContext, canPreferFork(ctx.sessionManager));
        if ("error" in contextPolicyResult)
            return buildRequestedModeError(effectiveParams, contextPolicyResult.error);
        const contextPolicy = contextPolicyResult;
        effectiveParams = contextPolicy.params;
        const sessionName = resolveIntercomSessionTarget(deps.childRuntime?.intercomSessionName ?? deps.pi.getSessionName(), ctx.sessionManager.getSessionId());
        const intercomBridge = resolveIntercomBridge({
            config: deps.config.intercomBridge,
            override: effectiveParams.intercomBridge,
            context: effectiveParams.context === "fresh" || effectiveParams.context === "fork"
                ? effectiveParams.context
                : contextPolicy.usesFork ? "fork" : undefined,
            orchestratorTarget: sessionName,
        });
        const agents = applyScopedIntercomBridgeToAgents(discoveredAgents, intercomBridge, contextPolicy);
        const inheritedNestedRouteValue = inheritedNestedRoute(deps);
        const nestedParentAddress = inheritedNestedRouteValue ? inheritedNestedParentAddress(deps) : undefined;
        const shareEnabled = effectiveParams.share === true;
        const hasChain = (effectiveParams.chain?.length ?? 0) > 0;
        const hasTasks = (effectiveParams.tasks?.length ?? 0) > 0;
        const hasSingle = !hasChain && !hasTasks && Boolean(effectiveParams.agent);
        const allowClarifyTaskPrompt = hasChain
            && effectiveParams.clarify === true
            && ctx.hasUI
            && !(effectiveParams.chain?.some(isParallelStep) ?? false);
        const validationError = validateExecutionInput(effectiveParams, agents, hasChain, hasTasks, hasSingle, allowClarifyTaskPrompt, unknownAgentDiagnosticContext);
        if (validationError)
            return validationError;
        const foregroundMode = hasChain ? "chain" : hasTasks ? "parallel" : "single";
        const requestedSpawns = countRequestedSubagentSpawns(effectiveParams, deps.config);
        const spawnPreflight = preflightSpawnBudget(deps.state, deps.config, requestSessionId, requestedSpawns);
        if (spawnPreflight.error)
            return spawnBudgetErrorResult(spawnPreflight.error, foregroundMode);
        let forkSessionFileForIndex = () => undefined;
        let prepareForkSessionForIndex = async () => { };
        // Check before pruner/session preparation, then recheck immediately before each fork
        // because the session capability ceiling can tighten while preparation awaits.
        const launchCapabilityCeiling = () => intersectSubagentCapabilityCeilings(intersectSubagentCapabilityCeilings(effectiveParams.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(requestSessionId)), deps.childRuntime?.capabilityCeiling);
        const assertLaunchableAgentsAllowedBeforeFork = () => {
            if (!contextPolicy.usesFork)
                return;
            const ceiling = launchCapabilityCeiling();
            const launchable = hasSingle
                ? [effectiveParams.agent]
                : hasTasks
                    ? (effectiveParams.tasks ?? []).map((task) => task.agent)
                    : (effectiveParams.chain ?? []).flatMap((step) => isDynamicParallelStep(step)
                        && (step.expand.maxItems ?? deps.config.chain?.dynamicFanout?.maxItems ?? 0) === 0
                        ? []
                        : getStepAgents(step));
            for (const agent of launchable)
                assertAgentAllowedByCapabilityCeiling(agent, ceiling);
        };
        // Forked children keep their requested thinking level. Signed Anthropic thinking
        // blocks are stripped from the inherited transcript by the resolver (they are bound
        // to the parent session), which is not a reason to disable the child's own reasoning.
        try {
            assertLaunchableAgentsAllowedBeforeFork();
            const pruneSession = contextPolicy.usesFork && deps.config.forkContext?.mode === "pruned"
                ? await createPrunedForkSessionWriter(ctx, deps.config.forkContext, signal)
                : undefined;
            const forkContextResolver = createForkContextResolver(ctx.sessionManager, contextPolicy.usesFork ? "fork" : undefined, pruneSession ? { pruneSession } : {});
            prepareForkSessionForIndex = forkContextResolver.prepareSessionForIndex;
            forkSessionFileForIndex = forkContextResolver.sessionFileForIndex;
        }
        catch (error) {
            return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
        }
        const selectedAgentNames = hasSingle
            ? [effectiveParams.agent]
            : hasTasks
                ? (effectiveParams.tasks ?? []).map((task) => task.agent)
                : (effectiveParams.chain ?? []).flatMap((step) => getStepAgents(step));
        const externalAgent = selectedAgentNames
            .map((name) => agents.find((agent) => agent.name === name))
            .find((agent) => agent?.runner?.type === "external-cli" || agent?.runner?.type === "external-job");
        const externalAsyncRequired = Boolean(externalAgent) && effectiveParams.async === undefined && effectiveParams.clarify !== true && effectiveParams.foregroundOnly !== true;
        const requestedAsync = externalAsyncRequired ? true : effectiveParams.async ?? deps.asyncByDefault;
        const backgroundRequestedWhileClarifying = (hasChain || hasTasks) && requestedAsync && effectiveParams.clarify === true;
        const effectiveAsync = requestedAsync && effectiveParams.clarify !== true;
        if (externalAgent && (!effectiveAsync || effectiveParams.foregroundOnly === true)) {
            return buildRequestedModeError(effectiveParams, `Agent '${externalAgent.name}' uses runner.type='${externalAgent.runner?.type}', which currently supports async/background execution only. Omit async or pass async:true; clarify and foregroundOnly are unsupported.`);
        }
        if (effectiveAsync && hasSingle && effectiveParams.resume === undefined && effectiveParams.worktree === true) {
            try {
                await preflightWorktreeSource(effectiveCwd, { signal });
            }
            catch (error) {
                return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
            }
        }
        const runId = randomUUID();
        const foregroundTimeout = resolveSingleAgentLaunchTimeout(effectiveParams, effectiveAsync, resolveConfigDefaultTimeoutMs(deps.config.timeoutMs));
        if (foregroundTimeout.error)
            return buildRequestedModeError(effectiveParams, foregroundTimeout.error);
        const controlConfig = resolveControlConfig(deps.config.control, effectiveParams.control);
        const requestedWorkflowChildAsyncId = typeof effectiveParams.workflowChildAsyncId === "string" ? effectiveParams.workflowChildAsyncId.trim() : "";
        const asyncRunId = requestedWorkflowChildAsyncId && path.basename(requestedWorkflowChildAsyncId) === requestedWorkflowChildAsyncId
            ? requestedWorkflowChildAsyncId
            : randomUUID();
        const topLevelAsyncCapacityEligible = depth === 0 && !inheritedNestedRouteValue && !effectiveParams.workflowParentRunId;
        const topLevelAsync = effectiveAsync && topLevelAsyncCapacityEligible;
        let activeAsyncCapacity;
        if (topLevelAsync) {
            try {
                const activeLimit = resolveMaxActiveAsyncRunsPerSession(deps.config.maxActiveAsyncRunsPerSession);
                activeAsyncCapacity = acquireActiveAsyncCapacity({
                    sessionId: requestSessionId,
                    limit: activeLimit,
                    runId: asyncRunId,
                    kind: "runner",
                    asyncDir: path.join(DIRS.async, asyncRunId),
                }, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) });
                deps.state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(requestSessionId, activeLimit, { liveWorkflowRunIds: new Set(deps.state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(deps.config.capacity?.abandonedSlotReleaseAfterMs) });
            }
            catch (error) {
                if (error instanceof ActiveAsyncCapacityError) {
                    deps.state.activeAsyncCapacity = error.snapshot;
                    return { content: [{ type: "text", text: error.message }], isError: true, details: { mode: foregroundMode, results: [], activeAsyncCapacity: error.snapshot } };
                }
                throw error;
            }
        }
        let runFanoutBudget;
        try {
            const inheritedRunFanoutBudgetValue = effectiveParams.runFanoutBudget ? undefined : inheritedRunFanoutBudget(deps);
            runFanoutBudget = effectiveParams.runFanoutBudget
                ?? (inheritedRunFanoutBudgetValue ? { ...inheritedRunFanoutBudgetValue, parentPath: `${inheritedRunFanoutBudgetValue.parentPath ? `${inheritedRunFanoutBudgetValue.parentPath}/` : ""}${runId}` } : undefined)
                ?? createRunFanoutBudget(runId, resolveMaxSubagentSpawnsPerRun(deps.config.maxSubagentSpawnsPerRun));
            if (!effectiveParams.runFanoutAdmitted)
                claimRunFanoutBatch(runFanoutBudget, staticRunFanoutPaths(effectiveParams));
        }
        catch (error) {
            activeAsyncCapacity?.rollback();
            if (error instanceof RunFanoutLimitError)
                return runFanoutErrorResult(error, foregroundMode);
            return buildRequestedModeError(effectiveParams, error instanceof Error ? error.message : String(error));
        }
        const nestedRoute = inheritedNestedRouteValue ?? createNestedRoute(runId);
        const artifactConfig = omitUndefinedProperties({
            ...DEFAULT_ARTIFACT_CONFIG,
            enabled: effectiveParams.artifacts !== false,
            dir: deps.config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
        });
        const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
        if (artifactConfig.dir === "project" && !warnedArtifactPackageDirs.has(effectiveCwd)) {
            warnedArtifactPackageDirs.add(effectiveCwd);
            const warning = getProjectArtifactPackagingWarning(effectiveCwd);
            if (warning)
                console.warn(`[pi-subagents] ${warning}`);
        }
        let sessionRoot;
        if (effectiveParams.sessionDir) {
            // An explicit sessionDir is a root keyed by this launch's run id so
            // concurrent children resolve distinct per-child session files.
            sessionRoot = path.join(path.resolve(deps.expandTilde(effectiveParams.sessionDir)), runId);
        }
        else {
            const baseSessionRoot = deps.config.defaultSessionDir
                ? path.resolve(deps.expandTilde(deps.config.defaultSessionDir))
                : deps.getSubagentSessionRoot(parentSessionFile);
            sessionRoot = path.join(baseSessionRoot, runId);
        }
        try {
            fs.mkdirSync(sessionRoot, { recursive: true });
        }
        catch (error) {
            activeAsyncCapacity?.rollback();
            const message = error instanceof Error ? error.message : String(error);
            return toExecutionErrorResult(effectiveParams, new Error(`Failed to create session directory '${sessionRoot}': ${message}`), contextPolicy.contextSummary);
        }
        const sessionDirForIndex = (idx) => path.join(sessionRoot, `run-${idx ?? 0}`);
        const forkSessionFileForTask = (agentName, idx = 0) => {
            if (!shouldForkAgent(contextPolicy, agentName))
                return undefined;
            return forkSessionFileForIndex(idx);
        };
        const prepareForkSessionForTask = async (agentName, idx = 0) => {
            if (!shouldForkAgent(contextPolicy, agentName))
                return;
            await prepareForkSessionForIndex(idx);
        };
        const thinkingOverrideForTask = () => delegatedThinkingOverride;
        const childSessionFileForTask = (agentName, idx, modelOverride, modelOverrideFromParent, modelOrigin) => forkSessionFileForTask(agentName, idx, modelOverride, modelOverrideFromParent, modelOrigin) ?? path.join(sessionDirForIndex(idx), "session.jsonl");
        const childSessionFileForIndex = (idx) => path.join(sessionDirForIndex(idx), "session.jsonl");
        try {
            // The ceiling can change while the pruned writer is built; clarify skips preflight but
            // still branches the parent session at launch.
            assertLaunchableAgentsAllowedBeforeFork();
            if (!(effectiveParams.clarify === true && ctx.hasUI) || deps.config.forkContext?.mode === "pruned") {
                const prepareAllowedForkSession = async (agent, ...rest) => {
                    assertAgentAllowedByCapabilityCeiling(agent, launchCapabilityCeiling());
                    await prepareForkSessionForTask(agent, ...rest);
                };
                await preflightForkSessionsForStaticTasks(effectiveParams, contextPolicy, prepareAllowedForkSession, deps.config.chain?.dynamicFanout?.maxItems);
            }
        }
        catch (error) {
            activeAsyncCapacity?.rollback();
            return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
        }
        const chainBindingsError = validateExecutionChainBindings(effectiveParams, deps.config.chain?.dynamicFanout?.maxItems);
        if (chainBindingsError) {
            activeAsyncCapacity?.rollback();
            return withResolvedContext(chainBindingsError, contextPolicy.contextSummary);
        }
        const onUpdateWithContext = onUpdate
            ? (r) => onUpdate(withResolvedContext({
                ...r,
                details: { ...r.details, runId },
            }, contextPolicy.contextSummary))
            : undefined;
        let missionBinding;
        let missionWarning;
        const explicitMission = effectiveParams.missionId !== undefined || effectiveParams.mission !== undefined;
        try {
            missionBinding = prepareMissionLaunch({
                params: effectiveParams,
                projectRoot: effectiveCwd,
                ...(deps.config.missions ? { config: deps.config.missions } : {}),
                ownerSessionId: requestSessionId,
            });
        }
        catch (error) {
            if (explicitMission) {
                activeAsyncCapacity?.rollback();
                return toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
            }
            missionWarning = `Mission tracking unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
        const attachMission = (result) => {
            if (!missionBinding)
                return missionWarning ? { ...result, details: { ...result.details, missionWarning } } : result;
            try {
                return attachMissionToLaunchResult({ binding: delegatedExecution ? { ...missionBinding, announceInContent: false } : missionBinding, result });
            }
            catch (error) {
                const warning = `Mission tracking unavailable after launch: ${error instanceof Error ? error.message : String(error)}`;
                if (explicitMission) {
                    return {
                        ...result,
                        isError: true,
                        content: [...result.content, { type: "text", text: warning }],
                        details: { ...result.details, missionWarning: warning },
                    };
                }
                return { ...result, details: { ...result.details, missionWarning: warning } };
            }
        };
        const reservation = reserveSpawnBudget(deps.state, deps.config, requestSessionId, requestedSpawns);
        if (reservation.error) {
            activeAsyncCapacity?.rollback();
            return attachMission(spawnBudgetErrorResult(reservation.error, foregroundMode));
        }
        const execData = omitUndefinedProperties({
            params: effectiveParams,
            effectiveCwd,
            requestedCwd,
            ctx,
            signal,
            onUpdate: onUpdateWithContext,
            agents,
            unknownAgentDiagnosticContext,
            recoveryAgents: discoveredAgents,
            runId,
            shareEnabled,
            sessionRoot,
            sessionDirForIndex,
            sessionFileForIndex: childSessionFileForIndex,
            sessionFileForTask: childSessionFileForTask,
            thinkingOverrideForTask,
            artifactConfig,
            artifactsDir,
            backgroundRequestedWhileClarifying,
            effectiveAsync,
            asyncRunId,
            controlConfig,
            ...(delegatedExecution ? { suppressUnchangedDelegationUpdates: true } : {}),
            intercomBridge,
            nestedRoute,
            timeoutMs: foregroundTimeout.timeoutMs,
            toolBudget: runToolBudget.toolBudget,
            usageBudget: usageBudget.budget,
            inheritedUsageBudget,
            allowZeroToolBudget,
            configToolBudget: configToolBudget.toolBudget,
            configToolTimeoutMs: deps.config.toolTimeoutMs,
            contextPolicy,
            modelScope,
            parentModel: requestParentModel,
            scopedModelIds: scopedModelIdsFromContext(ctx),
            parentSessionId: requestSessionId,
            parentPiSessionId: requestPiSessionId,
            capabilityCeiling: intersectSubagentCapabilityCeilings(effectiveParams.capabilityCeiling, resolveCurrentSubagentCapabilityCeiling(requestSessionId)),
            runFanoutBudget,
            topLevelAsyncCapacityEligible,
            activeAsyncCapacity,
            workflowChildPermitLaunch,
        });
        const foregroundDescription = selectedAgentNames.length === 1
            ? `${selectedAgentNames[0]} child`
            : `${selectedAgentNames.length} live children`;
        const foregroundControl = effectiveAsync
            ? undefined
            : compactOptional({
                runId,
                sessionId: requestSessionId,
                mode: foregroundMode,
                ...(effectiveParams.workflowParentRunId ? { parentWorkflowRunId: effectiveParams.workflowParentRunId } : {}),
                ...(effectiveParams.workflowKey ? { workflowKey: effectiveParams.workflowKey } : {}),
                startedAt: Date.now(),
                updatedAt: Date.now(),
                cwd: effectiveCwd,
                currentAgent: undefined,
                currentIndex: undefined,
                description: foregroundDescription,
                currentActivityState: undefined,
                activeChildren: new Map(),
                // The outer executor owns scheduling until its finally block settles.
                schedulingOwners: 1,
                nestedRoute,
                interrupt: undefined,
            });
        if (foregroundControl) {
            foregroundControl.promptAuditRedo = async (index, guidance) => {
                const audit = getLivePromptAudit(foregroundControl, index);
                if (!audit?.rerun)
                    return { text: "Redo is not safe for this prompt in this slice.", isError: true };
                const rewrittenTask = await rewritePromptWithGuidance({
                    ctx,
                    authoredTask: audit.authoredTask,
                    runtimeAdditions: audit.runtimeAdditions,
                    finalEffectivePrompt: audit.finalEffectivePrompt,
                    guidance,
                    signal,
                });
                const redoParams = promptAuditRedoParams(audit.rerun.params, rewrittenTask);
                const previousForegroundId = deps.state.lastForegroundControlId;
                const launch = execute(randomUUID(), redoParams, signal, undefined, ctx, true);
                const newRunId = deps.state.lastForegroundControlId && deps.state.lastForegroundControlId !== previousForegroundId
                    ? deps.state.lastForegroundControlId
                    : undefined;
                if (!newRunId) {
                    const result = await launch;
                    return { text: result.content.find((item) => item.type === "text")?.text ?? "Prompt redo could not start.", isError: true };
                }
                foregroundControl.supersededByRunId = newRunId;
                const replacement = deps.state.foregroundControls.get(newRunId);
                if (replacement)
                    replacement.sourceRunId = foregroundControl.runId;
                void launch.then((result) => {
                    if (result.isError)
                        console.warn(`[pi-subagents] Prompt redo ${newRunId} failed: ${result.content.find((item) => item.type === "text")?.text ?? "unknown error"}`);
                }).catch((error) => {
                    console.warn(`[pi-subagents] Prompt redo ${newRunId} failed: ${error instanceof Error ? error.message : String(error)}`);
                });
                return { text: `Prompt redo started ${newRunId}.` };
            };
            deps.state.foregroundControls.set(runId, foregroundControl);
            deps.state.lastForegroundControlId = runId;
            deps.activateSupervisorTransport?.();
            deps.refreshResultDelivery?.();
        }
        const writeNestedForegroundEvent = (type, result) => {
            if (!inheritedNestedRouteValue || !nestedParentAddress)
                return;
            const now = Date.now();
            const details = result?.details;
            const state = type === "subagent.nested.started"
                ? "running"
                : details?.results.some((child) => child.interrupted || child.detached)
                    ? "paused"
                    : result?.isError || details?.results.some((child) => child.exitCode !== 0)
                        ? "failed"
                        : "complete";
            const errorText = result?.isError
                ? result.content.find((item) => item.type === "text")?.text
                : undefined;
            let startedLaunches;
            try {
                startedLaunches = collectStaticLaunchSummaries({
                    params: effectiveParams,
                    agents,
                    parentModel: requestParentModel,
                    scopedModelIds: scopedModelIdsFromContext(ctx),
                    availableModels: ctx.modelRegistry.getAvailable().map(toModelInfo),
                    currentProvider: requestParentModel?.provider,
                    modelScope,
                    thinkingOverrideForTask,
                    dynamicFanoutMaxItems: deps.config.chain?.dynamicFanout?.maxItems,
                });
            }
            catch (error) {
                console.error("Failed to resolve nested foreground launch metadata:", error);
                startedLaunches = selectedAgentNames.map((agent) => ({ agent }));
            }
            const agentsForSummary = startedLaunches.map((launch) => launch.agent);
            const leafIntercomTarget = agentsForSummary[0] && intercomBridgeAppliesToAgent(intercomBridge, contextPolicy, agentsForSummary[0])
                ? resolveSubagentIntercomTarget(runId, agentsForSummary[0], 0)
                : undefined;
            try {
                writeNestedEvent(inheritedNestedRouteValue, compactOptional({
                    type,
                    ts: now,
                    parentRunId: nestedParentAddress.parentRunId,
                    parentStepIndex: nestedParentAddress.parentStepIndex,
                    child: compactOptional({
                        id: runId,
                        parentRunId: nestedParentAddress.parentRunId,
                        parentStepIndex: nestedParentAddress.parentStepIndex,
                        depth: nestedParentAddress.depth,
                        path: nestedParentAddress.path,
                        ownerIntercomTarget: deps.childRuntime?.intercomSessionName,
                        leafIntercomTarget,
                        intercomTarget: leafIntercomTarget,
                        ownerState: state === "running" ? "live" : "gone",
                        mode: foregroundMode,
                        state,
                        agent: agentsForSummary[0],
                        ...(details?.results.length === 1 && details.results[0]?.sessionName ? { sessionName: details.results[0].sessionName } : {}),
                        agents: agentsForSummary,
                        ...(agentsForSummary.length === 1 && (type === "subagent.nested.started" ? startedLaunches[0]?.model : details?.results[0]?.model) ? { model: type === "subagent.nested.started" ? startedLaunches[0]?.model : details?.results[0]?.model } : {}),
                        ...(agentsForSummary.length === 1 && (type === "subagent.nested.started" ? startedLaunches[0]?.thinking : details?.results[0]?.thinking) ? { thinking: type === "subagent.nested.started" ? startedLaunches[0]?.thinking : details?.results[0]?.thinking } : {}),
                        startedAt: foregroundControl?.startedAt ?? now,
                        ...(state !== "running" ? { endedAt: now } : {}),
                        lastUpdate: now,
                        ...(details?.totalCost ? { totalCost: details.totalCost } : {}),
                        ...(errorText ? { error: errorText } : {}),
                        ...(type === "subagent.nested.started"
                            ? { steps: startedLaunches.map((launch) => ({
                                    agent: launch.agent,
                                    status: "running",
                                    ...(launch.model ? { model: launch.model } : {}),
                                    ...(launch.thinking ? { thinking: launch.thinking } : {}),
                                })) }
                            : details?.results.length
                                ? { steps: details.results.map((child) => ({
                                        agent: child.agent,
                                        ...(child.sessionName ? { sessionName: child.sessionName } : {}),
                                        status: child.interrupted || child.detached ? "paused" : child.exitCode === 0 ? "complete" : "failed",
                                        ...(child.model ? { model: child.model } : {}),
                                        ...(child.thinking ? { thinking: child.thinking } : {}),
                                        ...(child.sessionFile ? { sessionFile: child.sessionFile } : {}),
                                        ...(child.error ? { error: child.error } : {}),
                                    })) }
                                : {}),
                    }),
                }));
            }
            catch (error) {
                console.error("Failed to emit nested foreground status event:", error);
            }
        };
        let nestedForegroundStarted = false;
        let asyncLaunchFailed = false;
        try {
            if (effectiveAsync) {
                deps.state.liveAsyncSessionRoots ??= new Map();
                deps.state.liveAsyncSessionRoots.set(asyncRunId, sessionRoot);
            }
            if (workflowLaunchObserver) {
                const singleTask = hasTasks && effectiveParams.tasks?.length === 1 ? effectiveParams.tasks[0] : undefined;
                const singleSessionName = hasSingle
                    ? deriveChildSessionName({ agent: effectiveParams.agent, task: effectiveParams.task })
                    : singleTask
                        ? deriveChildSessionName({ agent: singleTask.agent, task: singleTask.task })
                        : undefined;
                const launch = hasSingle
                    ? { agent: effectiveParams.agent, ...(singleSessionName ? { sessionName: singleSessionName } : {}), sessionFile: childSessionFileForTask(effectiveParams.agent, 0, effectiveParams.model), async: effectiveAsync, runId: effectiveAsync ? asyncRunId : runId }
                    : singleTask
                        ? { agent: singleTask.agent, ...(singleSessionName ? { sessionName: singleSessionName } : {}), sessionFile: childSessionFileForTask(singleTask.agent, 0, singleTask.model), async: effectiveAsync, runId: effectiveAsync ? asyncRunId : runId }
                        : undefined;
                if (launch) {
                    workflowLaunchObservers.delete(params);
                    workflowLaunchObserver(launch);
                }
            }
            const asyncResult = await runAsyncPath(execData, deps);
            if (asyncResult) {
                asyncLaunchFailed = asyncResult.isError === true;
                return attachMission(withRunFanoutBudget(withResolvedContext(asyncResult, contextPolicy.contextSummary), runFanoutBudget));
            }
            if (foregroundControl) {
                writeNestedForegroundEvent("subagent.nested.started");
                nestedForegroundStarted = true;
            }
            const runFanoutAnnotateContent = !delegatedExecution;
            if (hasSingle) {
                const result = await runSinglePath(execData, deps);
                writeNestedForegroundEvent("subagent.nested.completed", result);
                return attachMission(withRunFanoutBudget(withResolvedContext(result, contextPolicy.contextSummary), runFanoutBudget, { annotateContent: runFanoutAnnotateContent }));
            }
        }
        catch (error) {
            asyncLaunchFailed = effectiveAsync;
            const errorResult = toExecutionErrorResult(effectiveParams, error, contextPolicy.contextSummary);
            if (nestedForegroundStarted)
                writeNestedForegroundEvent("subagent.nested.completed", errorResult);
            return attachMission(errorResult);
        }
        finally {
            if (effectiveAsync && (asyncLaunchFailed || (activeAsyncCapacity && !activeAsyncCapacity.owner.runnerStartedAt)))
                deps.state.liveAsyncSessionRoots?.delete(asyncRunId);
            if (activeAsyncCapacity && !activeAsyncCapacity.owner.runnerStartedAt)
                activeAsyncCapacity.rollback();
            if (foregroundControl) {
                settleForegroundSchedulingOwner(foregroundControl);
                removeForegroundControlIfIdle(deps.state, runId, deps.trackRetainedNestedRoute);
            }
        }
        return withResolvedContext({
            content: [{ type: "text", text: "Invalid params" }],
            isError: true,
            details: { mode: "single", results: [] },
        }, contextPolicy.contextSummary);
    };
    const executeWithSingleDispatchGuard = async (id, params, signal, onUpdate, ctx) => {
        const normalizedAction = typeof params.action === "string" ? params.action.trim() : params.action;
        const requestParams = normalizedAction ? { ...params, action: normalizedAction } : params;
        if (normalizedAction)
            return execute(id, requestParams, signal, onUpdate, ctx).then(withAggregatedToolUsage);
        const { depth } = checkSubagentDepth(deps.config.maxSubagentDepth, deps.childRuntime);
        const dispatchParams = applyForceTopLevelAsyncOverride(requestParams, depth, deps.config.forceTopLevelAsync === true);
        const runsForeground = dispatchParams.clarify === true || (dispatchParams.async ?? deps.asyncByDefault) !== true;
        if (!runsForeground)
            return execute(id, requestParams, signal, onUpdate, ctx).then(withAggregatedToolUsage);
        if (deps.state.subagentInProgress === true)
            return duplicateSubagentCallResult(requestParams);
        deps.state.subagentInProgress = true;
        try {
            return withAggregatedToolUsage(await execute(id, requestParams, signal, onUpdate, ctx));
        }
        finally {
            deps.state.subagentInProgress = false;
        }
    };
    const executePublic = (id, params, signal, onUpdate, ctx) => {
        const disabledFeatureError = disabledFeatureResult(params);
        if (disabledFeatureError)
            return Promise.resolve(disabledFeatureError);
        const normalized = normalizePublicSubagentExecution(params, { structuredWorkflows: disabledFeatures.features.has("workflow-scripts") });
        if (!normalized.ok) {
            return Promise.resolve({ content: [{ type: "text", text: normalized.error }], isError: true, details: { mode: normalized.mode, results: [] } });
        }
        let publicParams = normalized.params;
        const workflow = publicParams.workflow;
        const errorResult = (text) => Promise.resolve({ content: [{ type: "text", text }], isError: true, details: { mode: publicParams.action ? "management" : "workflow", results: [] } });
        // Models tend to put script text in the workflow string; say how to pass it instead.
        const scriptTextHint = " A workflow string is a named workflow resource or a script file path. To run script text, write it in one ```js workflow block in the same reply and call subagent({ workflow: true }).";
        if (publicParams.tasks !== undefined || publicParams.chain !== undefined) {
            // Normalization admits chain/tasks only with workflow scripts disabled; the original input was checked above.
            const kind = publicParams.tasks !== undefined ? "tasks" : "chain";
            const resolved = resolveStructuredWorkflowResource({ kind, steps: publicParams[kind], task: publicParams.task });
            if (!resolved.ok)
                return errorResult(resolved.error);
            const { tasks: _tasks, chain: _chain, task: _task, ...withoutStructuredInput } = publicParams;
            publicParams = { ...withoutStructuredInput, workflowScript: resolved.resource.script };
            workflowResourcePermits.set(publicParams, resolved.resource.permit);
        }
        else if (typeof workflow === "string" && !isWorkflowScriptPath(workflow)) {
            const resolved = resolveWorkflowResource(workflow, publicParams.args, ctx.sessionManager.getSessionId() ?? undefined);
            if (!resolved.ok)
                return Promise.resolve({ content: [{ type: "text", text: resolved.error + scriptTextHint }], isError: true, details: { mode: "workflow", results: [] } });
            const { workflow: _workflow, args: _args, ...withoutResourceInput } = publicParams;
            publicParams = { ...withoutResourceInput, workflowScript: resolved.resource.script };
            workflowResourcePermits.set(publicParams, resolved.resource.permit);
        }
        else if (workflow !== undefined || publicParams.workflowScript !== undefined) {
            const normalizedArgs = normalizeWorkflowArgs(publicParams.args);
            if ("error" in normalizedArgs)
                return errorResult(normalizedArgs.error);
            let workflowScript = publicParams.workflowScript;
            if (workflow !== undefined) {
                const source = workflow === true ? readReplyWorkflowScript(ctx.sessionManager, id) : readWorkflowScriptFile(workflow, publicParams.cwd, ctx.cwd);
                if ("error" in source)
                    return errorResult(workflow === true ? source.error : source.error + scriptTextHint);
                workflowScript = source.script;
            }
            const { workflow: _workflow, ...withoutWorkflowSource } = publicParams;
            publicParams = { ...withoutWorkflowSource, workflowScript, args: deepFreezeWorkflowArgs(normalizedArgs.args) };
        }
        publicExecutions.add(publicParams);
        return executeWithSingleDispatchGuard(id, publicParams, signal, onUpdate, ctx);
    };
    const executeDelegated = async (id, params, signal, onUpdate, ctx) => {
        const disabledFeatureError = disabledFeatureResult(params);
        if (disabledFeatureError)
            return disabledFeatureError;
        const delegatedParams = { ...params };
        const privateParams = delegatedParams;
        const thinkingOverride = privateParams.delegatedThinkingOverride;
        const allowZeroToolBudget = privateParams.delegatedAllowZeroToolBudget === true;
        const workflowPermit = privateParams.delegatedWorkflowPermit;
        delete privateParams.delegatedThinkingOverride;
        delete privateParams.delegatedAllowZeroToolBudget;
        delete privateParams.delegatedWorkflowPermit;
        if (thinkingOverride !== undefined)
            delegatedThinkingOverrides.set(delegatedParams, thinkingOverride);
        if (allowZeroToolBudget)
            delegatedZeroToolBudgets.add(delegatedParams);
        if (workflowPermit)
            workflowPermitContexts.set(delegatedParams, { root: workflowPermit });
        delegatedExecutions.add(delegatedParams);
        return withAggregatedToolUsage(await execute(id, delegatedParams, signal, onUpdate, ctx));
    };
    const executeScheduled = (id, params, signal, ctx) => {
        const ownerSessionId = resolveCurrentSessionId(ctx.sessionManager);
        const runtimeOwnerId = ctx.sessionManager.getSessionId() || null;
        let ownerExecutors = scheduledOwnerExecutors.get(runtimeOwnerId);
        if (!ownerExecutors) {
            ownerExecutors = new Map();
            scheduledOwnerExecutors.set(runtimeOwnerId, ownerExecutors);
        }
        let owner = ownerExecutors.get(ownerSessionId);
        if (!owner) {
            const state = createScheduledOwnerState(deps.state, ownerSessionId, ctx);
            owner = { state, executor: createSubagentExecutor({ ...deps, state }) };
            ownerExecutors.set(ownerSessionId, owner);
        }
        return owner.executor.executePublic(id, params, signal, undefined, ctx);
    };
    function* getCurrentSupervisorOwnerStates() {
        const ownerId = deps.state.supervisorOwnerSessionId;
        if (!ownerId)
            return;
        // File transitions remain separate entries; other runtime owners are never scanned.
        for (const owner of scheduledOwnerExecutors.get(ownerId)?.values() ?? [])
            yield owner.state;
    }
    return { execute: executeWithSingleDispatchGuard, executePublic, executeDelegated, executeScheduled, getCurrentSupervisorOwnerStates };
}
//# sourceMappingURL=subagent-executor.js.map