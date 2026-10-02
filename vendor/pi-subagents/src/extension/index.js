/**
 * Subagent Tool
 *
 * Full-featured subagent with sync and async modes.
 * - Sync (default): Streams output, renders markdown, tracks usage
 * - Async: Background execution, emits events when done
 *
 * Public execution mode: workflow (workflow: true reply block, script path, or named resource)
 * Toggle: async parameter (default: true; set asyncByDefault:false in config.json to opt out)
 *
 * Config file: ~/.pi/agent/extensions/subagent/config.json
 *   { "asyncByDefault": true, "defaultSubagentContext": "fork", "forkContext": { "mode": "pruned", "model": "provider/model" }, "forceTopLevelAsync": true, "maxSubagentDepth": 1, "intercomBridge": { "mode": "always", "instructionFile": "./intercom-bridge.md" }, "worktreeSetupHook": "./scripts/setup-worktree.mjs" }
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { keyText } from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { clearAgentDiscoveryCache, discoverAgentSnapshot, discoverAgents, discoverAgentsAll } from "../agents/agents.js";
import { resolveGlobalNpmRoot } from "../agents/global-npm-root.js";
import { buildAdvertisedAgentCatalog, buildAdvertisedAgentPrompt } from "../agents/advertised-agent-prompt.js";
import { clearRuntimeAgentsForPi, listRuntimeAgentConfigs, mergeRuntimeAgents } from "../agents/runtime-agent-registry.js";
import { registerRuntimeAgentEventListener } from "../agents/runtime-agent-events.js";
import { ensureAccessibleDir } from "../shared/accessible-dir.js";
import { cleanupAllArtifactDirs, cleanupOldArtifacts, getArtifactsDir } from "../shared/artifacts.js";
import { resolveCurrentSessionId } from "../shared/session-identity.js";
import { getAgentDir } from "../shared/utils.js";
import { isStaleExtensionContextError, MODEL_ONLY_TOOL, withCachedUiContext } from "../shared/extension-context.js";
import { currentCompletionOwnerId } from "../shared/completion-owner.js";
import { cleanupOldChainDirs } from "../shared/settings.js";
import { clearLegacyResultAnimationTimer, renderSubagentResult, renderSubagentSummary, setInlineWorkflowCoverage } from "../tui/render.js";
import { getInspectorPlugins, registerInspectorEventListener } from "../inspectors/plugins.js";
import { SubagentFleetStatus, resolveFleetViewPlacement } from "../tui/fleet-status.js";
import { readMainThinkingLevel, setMainThinkingLevelSource } from "../tui/running-tone.js";
import { createSubagentParamsSchema } from "./schemas.js";
import { resolveDisabledFeatureSurface } from "../shared/disabled-features.js";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.js";
import { getActiveAsyncCapacitySnapshot, resolveAbandonedSlotReleaseAfterMs, resolveMaxActiveAsyncRunsPerSession } from "../runs/background/active-async-capacity.js";
import { cleanupResultIndexes, missionObserverResultCandidateFiles } from "../runs/background/result-files.js";
import { ASYNC_RETENTION_DELAY_MS, cleanupAsyncRetention } from "../runs/background/async-retention.js";
import { createResultWatcher } from "../runs/background/result-watcher.js";
import { createResultDeliveryOwnership } from "../runs/background/result-delivery-ownership.js";
import { createScheduledRunManager } from "../runs/background/scheduled-runs.js";
import { registerSlashCommands } from "../slash/slash-commands.js";
import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.js";
import { registerMainWatchdog } from "../watchdog/register-main.js";
import { registerSlashSubagentBridge } from "../slash/slash-bridge.js";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.js";
import { renderSupervisorReply, renderSupervisorRequest, SUPERVISOR_REPLY_ENTRY_TYPE, SUPERVISOR_REQUEST_MESSAGE_TYPE, } from "../intercom/supervisor-ui.js";
import { registerHerdrStatusBridge } from "../integrations/herdr-status.js";
import { hasLiveSubagentWork, registerPiWebSessionLiveness } from "../integrations/pi-web-session-liveness.js";
import { createRetainedNestedRouteTracker } from "../runs/background/retained-nested-route-tracker.js";
import { listHerdrProjectPaneRoots, restoreHerdrProjectPaneSnapshots } from "../inspectors/herdr/project-panes.js";
import { registerSubagentRpcBridge } from "./rpc.js";
import { clearSlashSnapshots, getSlashRenderableSnapshot, resolveSlashMessageDetails, restoreSlashFinalSnapshots } from "../slash/slash-live-state.js";
import { resolveWaitToolConfig } from "../runs/background/subagent-wait.js";
import { registerWaitTool } from "../runs/background/wait-tool.js";
import { registerSubagentToolActivation } from "./tool-activation.js";
import { createWaitSubscriptionManager } from "../runs/background/wait-subscriptions.js";
import { drainOutstandingWork } from "../runs/background/auto-drain.js";
import registerSubagentNotify, { parseSubagentNotifyContent } from "../runs/background/notify.js";
import { formatSteeringNotice, handleSubagentSteeringNotice, SUBAGENT_STEERING_MESSAGE_TYPE } from "./steering-notices.js";
import { SUBAGENT_CHILD_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../runs/shared/child-runtime-config.js";
import { disposeChildSessions } from "../runs/shared/child-session.js";
import { resolveCurrentSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.js";
import { formatDuration, shortenPath } from "../shared/formatters.js";
import { loadConfig, resolveAsyncByDefault, resolveScheduledStoreRoot } from "./config.js";
import { buildSubagentToolDescription, buildSubagentToolPromptMetadata } from "./tool-description.js";
import { formatWorkflowPreflightSummary, normalizeWorkflowPreflight } from "../workflows/workflow-preflight.js";
import { runtimeReplacedAbortReason } from "../workflows/workflow-reuse.js";
import { finalizeToolResult } from "./tool-result.js";
import { removedModelWorkflowFieldError } from "./public-execution.js";
import { collectGoalContinuationNotices } from "../missions/goal-driver.js";
import { restoreForegroundRunHistory } from "../runs/foreground/foreground-history.js";
import { resolveMissionStoreLocation } from "../missions/store.js";
import { listRetainedChildren } from "../runs/background/retained-children.js";
import { DIRS, DEFAULT_ARTIFACT_CONFIG, SLASH_RESULT_TYPE, SLASH_TEXT_RESULT_TYPE, SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_PROCESS_TERMINAL_EVENT, SUBAGENT_CONTROL_EVENT, SUBAGENT_STEERING_NOTICE_EVENT, WIDGET_KEY, resolveMaxSubagentSpawnsPerSession, } from "../shared/types.js";
import { formatSubagentControlNotice, handleSubagentControlNotice, SUBAGENT_CONTROL_MESSAGE_TYPE, } from "./control-notices.js";
import { showUpgradeNotice } from "./upgrade-notice.js";
export { loadConfig, resolveAsyncByDefault } from "./config.js";
const SLOW_RELOAD_PHASE_MS = 250;
// Long enough for Pi to finish starting; loading the executor blocks the event loop for tens of ms.
const MODULE_PRELOAD_DELAY_MS = 1_000;
const RUNTIME_REGISTRY_STORE_KEY = "__piSubagentRuntimeRegistry";
function getRuntimeRegistry() {
    const globalStore = globalThis;
    const existing = globalStore[RUNTIME_REGISTRY_STORE_KEY];
    if (existing?.bySessionManager instanceof WeakMap && existing.activeEntries instanceof Set) {
        if (!(existing.visibleControlNoticesBySessionManager instanceof WeakMap)) {
            existing.visibleControlNoticesBySessionManager = new WeakMap();
        }
        return existing;
    }
    const registry = {
        bySessionManager: new WeakMap(),
        visibleControlNoticesBySessionManager: new WeakMap(),
        activeEntries: new Set(),
    };
    globalStore[RUNTIME_REGISTRY_STORE_KEY] = registry;
    return registry;
}
function logSlowPhase(label, startedAt) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= SLOW_RELOAD_PHASE_MS)
        console.error(`Subagent reload phase '${label}' took ${elapsed}ms.`);
}
function formatWorkflowPreflightCall(input) {
    if (input === undefined)
        return "";
    try {
        return formatWorkflowPreflightSummary(normalizeWorkflowPreflight(input));
    }
    catch (error) {
        return `preflight · rejected: ${error instanceof Error ? error.message : String(error)}`;
    }
}
/**
 * Derive subagent session base directory from parent session file.
 * If parent session is ~/.pi/agent/sessions/abc123.jsonl,
 * returns ~/.pi/agent/sessions/abc123/ as the base.
 * Callers add runId to create the actual session root: abc123/{runId}/
 * Falls back to a unique temp directory if no parent session.
 */
function getSubagentSessionRoot(parentSessionFile) {
    if (parentSessionFile) {
        const baseName = path.basename(parentSessionFile, ".jsonl");
        const sessionsDir = path.dirname(parentSessionFile);
        return path.join(sessionsDir, baseName);
    }
    return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}
function expandTilde(p) {
    return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}
function isSlashResultRunning(result) {
    return result.details?.progress?.some((entry) => entry.status === "running")
        || result.details?.results.some((entry) => entry.progress?.status === "running")
        || false;
}
function isSlashResultError(result) {
    return result.details?.results.some((entry) => entry.exitCode !== 0 && entry.progress?.status !== "running") || false;
}
function rebuildSlashResultContainer(container, result, options, theme, rendererConfig, foregroundDetachShortcut) {
    container.clear();
    container.addChild(new Spacer(1));
    const boxTheme = isSlashResultRunning(result) ? "toolPendingBg" : isSlashResultError(result) ? "toolErrorBg" : "toolSuccessBg";
    const box = new Box(1, 1, (text) => theme.bg(boxTheme, text));
    box.addChild(renderSubagentResult(result, options, theme, undefined, rendererConfig, foregroundDetachShortcut));
    container.addChild(box);
}
function createSlashResultComponent(details, options, theme, rendererConfig, foregroundDetachShortcut, getCurrentTheme = () => theme) {
    const container = new Container();
    let lastVersion = -1;
    let lastTheme;
    container.render = (width) => {
        const snapshot = getSlashRenderableSnapshot(details);
        const currentTheme = getCurrentTheme();
        if (snapshot.version !== lastVersion || currentTheme !== lastTheme || isSlashResultRunning(snapshot.result)) {
            lastVersion = snapshot.version;
            lastTheme = currentTheme;
            rebuildSlashResultContainer(container, snapshot.result, options, currentTheme, rendererConfig, foregroundDetachShortcut);
        }
        return Container.prototype.render.call(container, width);
    };
    return container;
}
class SubagentControlNoticeComponent {
    details;
    theme;
    constructor(details, theme) {
        this.details = details;
        this.theme = theme;
    }
    invalidate() { }
    render(width) {
        const eventLabel = this.details.event.type.replaceAll("_", " ");
        if (width < 3)
            return [truncateToWidth(`Subagent ${eventLabel}`, width)];
        const bodyWidth = Math.max(1, width - 2);
        const borderChar = "─";
        const header = ` ⚠ Subagent ${eventLabel}: ${this.details.event.agent} `;
        const headerText = truncateToWidth(header, bodyWidth, "");
        const headerPadding = Math.max(0, bodyWidth - visibleWidth(headerText));
        const lines = [this.theme.fg("accent", `╭${headerText}${borderChar.repeat(headerPadding)}╮`)];
        for (const line of wrapTextWithAnsi(formatSubagentControlNotice(this.details), bodyWidth)) {
            const text = truncateToWidth(line, bodyWidth, "");
            const padding = Math.max(0, bodyWidth - visibleWidth(text));
            lines.push(this.theme.fg("accent", `│${text}${" ".repeat(padding)}│`));
        }
        lines.push(this.theme.fg("accent", `╰${borderChar.repeat(bodyWidth)}╯`));
        return lines;
    }
}
export function projectActiveHerdrRuns(state) {
    const active = (status) => status === "queued" || status === "running";
    const foregroundChildrenByWorkflow = new Map();
    for (const control of state.foregroundControls.values()) {
        if (!control.parentWorkflowRunId)
            continue;
        const children = control.activeChildren?.size
            ? [...control.activeChildren.values()].map((child) => ({
                agent: child.agent,
                needsAttention: child.currentActivityState === "needs_attention",
            }))
            : control.currentAgent
                ? [{ agent: control.currentAgent, needsAttention: control.currentActivityState === "needs_attention" }]
                : [];
        if (children.length === 0)
            continue;
        const existing = foregroundChildrenByWorkflow.get(control.parentWorkflowRunId) ?? [];
        existing.push(...children);
        foregroundChildrenByWorkflow.set(control.parentWorkflowRunId, existing);
    }
    // Keep each async child under its own ID: completion and attention events
    // address that ID directly. The workflow row accounts only for foreground
    // children; its own coordinator and step summaries are not leaf agents.
    return [...state.asyncJobs.values()]
        .filter((job) => active(job.status))
        .map((job) => {
        const currentStep = job.steps?.find((step) => step.status === "running")
            ?? (job.currentStep !== undefined ? job.steps?.[job.currentStep] : undefined)
            ?? job.steps?.find((step) => step.status === "pending");
        if (job.mode === "workflow") {
            const children = foregroundChildrenByWorkflow.get(job.asyncId) ?? [];
            return {
                id: job.asyncId,
                coordinator: true,
                agents: children.map((child) => child.agent),
                ...(currentStep?.label ? { taskLabel: currentStep.label } : {}),
                needsAttention: job.activityState === "needs_attention" || children.some((child) => child.needsAttention),
            };
        }
        return {
            id: job.asyncId,
            agents: job.agents,
            ...(currentStep?.label ? { taskLabel: currentStep.label } : {}),
            needsAttention: job.activityState === "needs_attention",
        };
    });
}
export default function registerSubagentExtension(pi) {
    if (process.env[SUBAGENT_CHILD_ENV] === "1") {
        return;
    }
    const runtimeRegistry = getRuntimeRegistry();
    setMainThinkingLevelSource(() => readMainThinkingLevel(() => pi.getThinkingLevel()));
    DIRS.results = ensureAccessibleDir(DIRS.results);
    DIRS.async = ensureAccessibleDir(DIRS.async);
    cleanupOldChainDirs();
    const config = loadConfig();
    const waitToolConfig = resolveWaitToolConfig(config.waitTool);
    const asyncByDefault = resolveAsyncByDefault(config);
    const fleetViewEnabled = config.fleetView !== false;
    const fleetViewPlacement = resolveFleetViewPlacement(config.fleetViewPlacement);
    const asyncWidgetEnabled = config.asyncWidget !== false;
    const summaryInlineToolDisplay = config.inlineToolDisplay === "summary";
    const tempArtifactsDir = getArtifactsDir(null);
    const artifactCleanupDays = config.artifactConfig?.cleanupDays ?? DEFAULT_ARTIFACT_CONFIG.cleanupDays;
    cleanupAllArtifactDirs(artifactCleanupDays);
    let resultIndexCleanupTimer;
    const state = {
        baseCwd: "",
        currentSessionId: null,
        statusProjectionSessionId: null,
        completionOwnerId: currentCompletionOwnerId(),
        artifactDirPreference: config.artifactDir ?? DEFAULT_ARTIFACT_CONFIG.dir,
        ...(config.authorityPolicy ? { authorityPolicy: config.authorityPolicy } : {}),
        ...(config.missions ? { missionStoreConfig: config.missions } : {}),
        parentSessionFile: null,
        trustedSessionRoots: [],
        subagentInProgress: false,
        subagentSpawns: {
            sessionId: null,
            count: 0,
            configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
            granted: 0,
            grantHistory: [],
        },
        activeAsyncCapacity: { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 },
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
        widgetsSuspended: false,
        watcher: null,
        watcherRestartTimer: null,
        resultFileCoalescer: {
            schedule: () => false,
            clear: () => { },
        },
    };
    const withLastUiContext = (run) => {
        const cached = state.lastUiContext;
        return withCachedUiContext(cached, () => {
            if (state.lastUiContext === cached)
                state.lastUiContext = null;
        }, run);
    };
    const supervisorChannel = createNativeSupervisorChannel(pi, state, {
        // Owner states are created only by scheduled execution, which loads the executor first.
        getCurrentOwnerStates: () => executor?.getCurrentSupervisorOwnerStates() ?? [],
    });
    const waitSubscriptionManager = createWaitSubscriptionManager(pi, state);
    const mainWatchdog = registerMainWatchdog(pi);
    const resultDeliveryOwnership = createResultDeliveryOwnership(state);
    const completionNotifier = registerSubagentNotify(pi, state, { batchConfig: config.completionBatch, ownership: resultDeliveryOwnership });
    let retainedNestedRouteTracker;
    const fleetStatus = fleetViewEnabled
        ? new SubagentFleetStatus(state, async (itemKey) => {
            const ctx = withLastUiContext((current) => current);
            if (!ctx)
                return;
            try {
                const { openSubagentFleet } = await import("../tui/fleet.js");
                await openSubagentFleet(ctx, state, { initialKey: itemKey, asyncDirRoot: DIRS.async, resultsDir: DIRS.results, fleetKeybindings: config.fleetKeybindings, inspectorPlugins: () => getInspectorPlugins(pi) });
            }
            catch (error) {
                if (isStaleExtensionContextError(error)) {
                    if (state.lastUiContext === ctx)
                        state.lastUiContext = null;
                    return;
                }
                throw error;
            }
        }, { placement: fleetViewPlacement, onWorkflowCoverageChange: setInlineWorkflowCoverage })
        : undefined;
    let goalTurnId = 0;
    let releaseHostSessionLiveness = () => { };
    const scheduledStoreRoot = config.scheduledRuns?.storeRoot === undefined ? undefined : resolveScheduledStoreRoot(config.scheduledRuns.storeRoot);
    const scheduledRunManager = createScheduledRunManager({
        config,
        storeRoot: scheduledStoreRoot,
        launch: async (params, ctx, signal) => {
            await waitForAdvertisement();
            return (await getExecutor()).executeScheduled(randomUUID(), params, signal, ctx);
        },
        resolveCapabilityCeiling: (sessionId) => resolveCurrentSubagentCapabilityCeiling(sessionId),
    });
    let refreshResultDelivery = () => { };
    let advertisedAgents = [];
    let advertisedContext;
    let advertisementGeneration = 0;
    let globalRoot = null;
    let advertisementReady = Promise.resolve();
    let notifySessionChange = () => { };
    let sessionChanged = Promise.resolve();
    const waitForAdvertisement = async () => {
        let pending;
        do {
            pending = advertisementReady;
            const result = await Promise.race([pending, sessionChanged]);
            if (pending === advertisementReady && result)
                throw result.error;
        } while (pending !== advertisementReady);
    };
    const refreshAdvertisedAgents = () => {
        advertisedAgents = [];
        if (!advertisedContext)
            return;
        clearAgentDiscoveryCache();
        advertisedAgents = discoverAgents(advertisedContext.cwd, "both", advertisedContext.model?.provider, { globalNpmRoot: globalRoot }).agents
            .filter((agent) => agent.advertise === true);
    };
    const beginAdvertisement = (ctx) => {
        const generation = ++advertisementGeneration;
        notifySessionChange();
        sessionChanged = new Promise((resolve) => { notifySessionChange = resolve; });
        advertisedAgents = [];
        advertisedContext = { cwd: ctx.cwd, model: ctx.model };
        globalRoot = null;
        advertisementReady = resolveGlobalNpmRoot().then((root) => {
            if (generation !== advertisementGeneration)
                return;
            globalRoot = root;
            refreshAdvertisedAgents();
        }).catch((error) => {
            if (generation !== advertisementGeneration)
                return;
            // Settle without an unhandled rejection if no turn follows session_start.
            console.error("Failed to refresh advertised agents:", error);
            return { error };
        });
    };
    const hasResultDeliveryDemand = () => {
        if ([...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running"))
            return true;
        if (state.foregroundControls.size > 0)
            return true;
        if (scheduledRunManager.observedCompletionRunIds().size > 0)
            return true;
        return missionObserverResultCandidateFiles(DIRS.results).length > 0;
    };
    const discoverAgentsForRuntime = (cwd, scope, preferredModelProvider) => {
        if (listRuntimeAgentConfigs(pi).length === 0)
            return discoverAgents(cwd, scope, preferredModelProvider, { globalNpmRoot: globalRoot });
        const snapshot = discoverAgentSnapshot(cwd, scope, preferredModelProvider, { includeChains: false, globalNpmRoot: globalRoot });
        const discovered = snapshot.effective;
        const all = snapshot.all;
        const configuredAgents = [
            ...all.builtin,
            ...all.package,
            ...all.user,
            ...all.project,
        ];
        const merged = mergeRuntimeAgents(pi, discovered, configuredAgents, { cwd, scope, preferredModelProvider });
        if (discovered.maxThinking === undefined)
            return merged;
        return {
            ...merged,
            agents: merged.agents.map((agent) => agent.maxThinking === discovered.maxThinking ? agent : { ...agent, maxThinking: discovered.maxThinking }),
        };
    };
    const { ensurePoller, refreshWidget, handleStarted, handleComplete, resetJobs, restoreActiveJobs, dispose: disposeAsyncJobTracker } = createAsyncJobTracker(pi, state, DIRS.async, {
        widgetEnabled: asyncWidgetEnabled,
        onJobTerminal: () => refreshResultDelivery(),
        supervisorRequestState: supervisorChannel.getSupervisorRequestState,
    });
    const resultWatcher = createResultWatcher(pi, state, DIRS.results, 10 * 60 * 1000, {
        notifier: completionNotifier,
        ownership: resultDeliveryOwnership,
        observeCompletion: (result) => scheduledRunManager.handleAsyncCompletion(result),
        observedCompletionRunIds: () => scheduledRunManager.observedCompletionRunIds(),
        hasDeliveryDemand: hasResultDeliveryDemand,
        deliverIntercomResults: config.intercomBridge?.resultDelivery === true,
        resultScanLogging: config.resultScanLogging,
    });
    const { startResultWatcher, transitionResultDelivery, primeExistingResults, stopResultWatcher } = resultWatcher;
    refreshResultDelivery = resultWatcher.refreshResultDelivery;
    const asyncRetentionAbort = new AbortController();
    let asyncRetentionTimer;
    const startSessionMaintenance = () => {
        if (!resultIndexCleanupTimer) {
            resultIndexCleanupTimer = setTimeout(() => {
                try {
                    cleanupResultIndexes(DIRS.results);
                }
                catch (error) {
                    console.error("Failed to clean stale subagent result indexes:", error);
                }
            }, 30_000);
            resultIndexCleanupTimer.unref?.();
        }
        waitSubscriptionManager.start();
        if (!asyncRetentionTimer) {
            asyncRetentionTimer = setTimeout(async () => {
                try {
                    await cleanupAsyncRetention({
                        asyncDirRoot: DIRS.async,
                        resultsDir: DIRS.results,
                        signal: asyncRetentionAbort.signal,
                        protectedRunIds: new Set([
                            ...state.asyncJobs.keys(),
                            ...(state.workflowControllers?.keys() ?? []),
                            ...scheduledRunManager.referencedAsyncRunIds(),
                        ]),
                    });
                }
                catch (error) {
                    console.error("Failed to clean retained async subagent state:", error);
                }
            }, ASYNC_RETENTION_DELAY_MS);
            asyncRetentionTimer.unref?.();
        }
    };
    const executorDeps = {
        pi,
        state,
        config,
        asyncByDefault,
        waitToolEnabled: waitToolConfig.enabled,
        waitToolDefaultTimeoutMs: waitToolConfig.defaultTimeoutMs,
        handleScheduledRunAction: (params, ctx) => scheduledRunManager.handleToolCall(params, ctx),
        watchdog: mainWatchdog,
        tempArtifactsDir,
        getSubagentSessionRoot,
        expandTilde,
        discoverAgents: discoverAgentsForRuntime,
        discoverAgentsAll: (cwd, provider) => discoverAgentsAll(cwd, provider, { globalNpmRoot: globalRoot }),
        onAgentsChanged: () => {
            try {
                refreshAdvertisedAgents();
            }
            catch (error) {
                // The mutation already persisted. Withdraw stale guidance, not its result.
                console.error("Failed to refresh advertised agents; catalog withdrawn until refresh:", error);
            }
        },
        activateSupervisorTransport: () => supervisorChannel.activateTransport(),
        findPendingAsks: (target) => supervisorChannel.findPendingAsks(target),
        refreshResultDelivery: () => refreshResultDelivery(),
        trackRetainedNestedRoute: undefined,
    };
    let executor;
    let executorPromise;
    let executorModulePromise;
    const loadExecutorModule = () => executorModulePromise ??= import("../runs/foreground/subagent-executor.js");
    const getExecutor = () => {
        executorPromise ??= loadExecutorModule().then(({ createSubagentExecutor }) => {
            executor = createSubagentExecutor(executorDeps);
            return executor;
        });
        return executorPromise;
    };
    // Loading these on first use could happen days after startup, when pi-subagents may have
    // changed on disk and the new files would import stale cached copies of modules loaded at
    // startup. Load them shortly after a session starts instead, off Pi's startup path; child
    // runtimes return before registration and never schedule this.
    let modulePreloadTimer;
    const scheduleModulePreload = () => {
        if (executorModulePromise || modulePreloadTimer)
            return;
        modulePreloadTimer = setTimeout(() => {
            // Errors surface from the first call that needs the module.
            loadExecutorModule().catch(() => { });
            if (fleetViewEnabled)
                import("../tui/fleet.js").catch(() => { });
        }, MODULE_PRELOAD_DELAY_MS);
        modulePreloadTimer.unref?.();
    };
    pi.registerMessageRenderer(SUPERVISOR_REQUEST_MESSAGE_TYPE, renderSupervisorRequest);
    const registerEntryRenderer = pi.registerEntryRenderer;
    if (typeof registerEntryRenderer === "function") {
        registerEntryRenderer.call(pi, SUPERVISOR_REPLY_ENTRY_TYPE, renderSupervisorReply);
    }
    pi.registerMessageRenderer(SLASH_RESULT_TYPE, (message, options, theme) => {
        const details = resolveSlashMessageDetails(message.details);
        if (!details)
            return undefined;
        return createSlashResultComponent(details, options, theme, config.mainWindowRenderer, config.foregroundDetachShortcut, () => state.lastUiContext?.ui.theme ?? theme);
    });
    pi.registerMessageRenderer(SLASH_TEXT_RESULT_TYPE, (message, _options, _theme) => {
        const content = typeof message.content === "string"
            ? message.content
            : message.content
                .filter((entry) => entry.type === "text")
                .map((entry) => entry.text)
                .join("\n");
        return new Text(content, 0, 0);
    });
    pi.registerMessageRenderer("subagent-notify", (message, options, theme) => {
        const content = typeof message.content === "string" ? message.content : "";
        const details = message.details ?? parseSubagentNotifyContent(content);
        if (!details)
            return new Text(content, 0, 0);
        const icon = details.status === "completed"
            ? theme.fg("success", "✓")
            : details.status === "paused"
                ? theme.fg("warning", "■")
                : theme.fg("error", "✗");
        const parts = [];
        if (details.taskInfo)
            parts.push(details.taskInfo);
        if (details.durationMs !== undefined)
            parts.push(formatDuration(details.durationMs));
        let text = `${icon} ${theme.bold(details.agent)} ${theme.fg("dim", details.status)}`;
        if (parts.length > 0)
            text += ` ${theme.fg("dim", "·")} ${parts.map((part) => theme.fg("dim", part)).join(` ${theme.fg("dim", "·")} `)}`;
        const trimmedPreview = details.resultPreview.trim();
        const previewLines = options.expanded
            ? trimmedPreview.split("\n").filter((line) => line.trim())
            : [trimmedPreview.split("\n", 1)[0] ?? ""].filter((line) => line.trim());
        for (const line of previewLines.length > 0 ? previewLines : ["(no output)"]) {
            text += `\n  ${theme.fg("dim", `⎿  ${line}`)}`;
        }
        if (!options.expanded && trimmedPreview.includes("\n")) {
            const expandKey = keyText("app.tools.expand");
            text += `\n  ${theme.fg("dim", `${expandKey} full notification`)}`;
        }
        if (details.workflowRunId) {
            text += `\n  ${theme.fg("muted", `workflow: ${details.workflowRunId}`)}`;
        }
        if (details.childRuns?.length) {
            text += `\n  ${theme.fg("muted", `children: ${details.childRuns.map((child) => `${child.workflowKey ?? child.agent ?? "child"}=${child.runId}`).join(", ")}`)}`;
        }
        if (details.reconciledFromDetachedChild) {
            text += `\n  ${theme.fg("muted", `reconciled child: ${details.reconciledFromDetachedChild}`)}`;
        }
        if (details.sessionLabel && details.sessionValue) {
            text += `\n  ${theme.fg("muted", `${details.sessionLabel}: ${shortenPath(details.sessionValue)}`)}`;
        }
        return new Text(text, 0, 0);
    });
    pi.registerMessageRenderer(SUBAGENT_STEERING_MESSAGE_TYPE, (message, _options, theme) => {
        const details = message.details;
        if (!details)
            return undefined;
        return new Text(theme.fg(details.state === "recovered" ? "warning" : "error", formatSteeringNotice(details)), 0, 0);
    });
    pi.registerMessageRenderer(SUBAGENT_CONTROL_MESSAGE_TYPE, (message, _options, theme) => {
        const details = message.details;
        if (!details?.event)
            return undefined;
        const content = typeof message.content === "string" ? message.content : undefined;
        return new SubagentControlNoticeComponent({ ...details, noticeText: formatSubagentControlNotice(details, content) }, theme);
    });
    const executeSubagentReady = async (id, params, signal, onUpdate, ctx) => {
        await waitForAdvertisement();
        return (await getExecutor()).executePublic(id, params, signal, onUpdate, ctx);
    };
    const executeSubagentCollapsed = (id, params, signal, onUpdate, ctx) => {
        if (ctx.hasUI)
            ctx.ui.setToolsExpanded(false);
        return executeSubagentReady(id, params, signal, onUpdate, ctx);
    };
    const slashBridge = registerSlashSubagentBridge({
        events: pi.events,
        getContext: () => state.lastUiContext,
        execute: (id, params, signal, onUpdate, ctx) => executeSubagentCollapsed(id, params, signal, onUpdate, ctx),
    });
    const promptTemplateBridge = registerPromptTemplateDelegationBridge({
        events: pi.events,
        getContext: () => state.lastUiContext,
        execute: (requestId, params, signal, ctx, onUpdate) => executeSubagentCollapsed(requestId, params, signal, onUpdate, ctx),
        executeStructured: async (requestId, params, signal, ctx, onUpdate) => {
            if (ctx.hasUI)
                ctx.ui.setToolsExpanded(false);
            await waitForAdvertisement();
            return (await getExecutor()).executeDelegated(requestId, params, signal, onUpdate, ctx);
        },
    });
    const disabledFeatures = resolveDisabledFeatureSurface(config);
    const rpcBridge = registerSubagentRpcBridge({
        events: pi.events,
        getContext: () => state.lastUiContext,
        execute: executeSubagentReady,
        state,
        disabledFeatures,
    });
    const parameters = createSubagentParamsSchema(disabledFeatures);
    const tool = {
        name: "subagent",
        ...MODEL_ONLY_TOOL,
        label: "Subagent",
        description: buildSubagentToolDescription(config, { disabledFeatures }),
        ...buildSubagentToolPromptMetadata(config, disabledFeatures),
        parameters,
        async execute(id, params, signal, onUpdate, ctx) {
            const removedField = removedModelWorkflowFieldError(params);
            if (removedField)
                throw new Error(removedField);
            return finalizeToolResult(await executeSubagentCollapsed(id, params, signal ?? new AbortController().signal, onUpdate, ctx));
        },
        renderCall(args, theme) {
            const gap = " ".repeat(config.mainWindowRenderer?.horizontalSpacing ?? 1);
            const title = theme.fg("toolTitle", theme.bold("subagent"));
            if (args.action) {
                const target = args.agent || "";
                return new Text(`${title}${gap}${args.action}${target ? `${gap}${theme.fg("accent", target)}` : ""}`, 0, 0);
            }
            if (args.workflow !== undefined)
                return new Text(`${title}${gap}${theme.fg("accent", args.workflow === true ? "workflow (reply block)" : `workflow ${String(args.workflow)}`)}${args.async === true ? `${gap}${theme.fg("warning", "[async]")}` : ""}${args.preflight !== undefined ? `${gap}${theme.fg("dim", formatWorkflowPreflightCall(args.preflight))}` : ""}`, 0, 0);
            const asyncLabel = args.async === true ? `${gap}${theme.fg("warning", "[async]")}` : "";
            return new Text(`${title}${gap}${theme.fg("accent", args.agent || "?")}${asyncLabel}`, 0, 0);
        },
        renderResult(result, options, theme, context) {
            clearLegacyResultAnimationTimer(context);
            const renderedResult = { ...result, isError: context.isError };
            return summaryInlineToolDisplay
                ? renderSubagentSummary(renderedResult, options, theme)
                : renderSubagentResult(renderedResult, options, theme, undefined, config.mainWindowRenderer, config.foregroundDetachShortcut);
        },
    };
    pi.registerTool(tool);
    pi.on("before_agent_start", async (event, ctx) => {
        await waitForAdvertisement();
        if (!event.systemPromptOptions.selectedTools.includes("subagent"))
            return;
        const sessionId = state.currentSessionId ?? resolveCurrentSessionId(ctx.sessionManager);
        // Structured sections let Pi append a transcript delta instead of replacing the
        // cached system prompt. Set the section on every turn it applies: Pi rebuilds the
        // options each turn, and an unset turn records a removal.
        const catalog = buildAdvertisedAgentCatalog(advertisedAgents, resolveCurrentSubagentCapabilityCeiling(sessionId));
        if (catalog)
            event.systemPromptOptions.sections.advertised_subagents = catalog;
    });
    registerWaitTool(pi, state, waitToolConfig.enabled, waitSubscriptionManager, waitToolConfig.defaultTimeoutMs, undefined, supervisorChannel.hasPendingRequests);
    pi.on("agent_end", async (_event, ctx) => {
        if (!ctx.hasUI)
            await drainOutstandingWork({ state, events: pi.events, hasPendingSupervisorRequest: supervisorChannel.hasPendingRequests });
        const ownerSessionId = state.currentSessionId;
        if (!ownerSessionId)
            return;
        goalTurnId += 1;
        try {
            const location = resolveMissionStoreLocation({ projectRoot: state.baseCwd, ...(config.missions ? { config: config.missions } : {}) });
            const retainedChildren = listRetainedChildren(DIRS.async, ownerSessionId);
            for (const notice of collectGoalContinuationNotices({ location, ownerSessionId, retainedChildren, turnId: goalTurnId })) {
                handleSubagentControlNotice({
                    pi,
                    state,
                    visibleControlNotices: new Set(),
                    details: { source: "goal", event: notice.event, noticeText: notice.message },
                });
            }
        }
        catch (error) {
            console.error("Failed to evaluate goal missions:", error);
        }
    });
    const disposeSlashCommands = registerSlashCommands(pi, state, {
        fleetKeybindings: config.fleetKeybindings,
        foregroundDetachShortcut: config.foregroundDetachShortcut,
        workflowScriptsDisabled: disabledFeatures.features.has("workflow-scripts"),
    });
    let visibleControlNotices = new Set();
    const activeHerdrRuns = () => projectActiveHerdrRuns(state);
    const herdrStatusBridge = registerHerdrStatusBridge({
        events: pi.events,
        getRuns: activeHerdrRuns,
        getProjectPaneCount: () => [...(state.herdrProjectPanes?.values() ?? [])].filter((pane) => pane.state === "open").length,
        async runHerdr(args) {
            await pi.exec(process.env.HERDR_BIN || "herdr", [...args], { timeout: 5_000 });
        },
    });
    const controlEventHandler = (payload) => {
        handleSubagentControlNotice({
            pi,
            state,
            visibleControlNotices,
            details: payload,
        });
    };
    const steeringNoticeHandler = (payload) => {
        handleSubagentSteeringNotice({ pi, state, details: payload });
    };
    const asyncStartedHandler = (payload) => {
        handleStarted(payload);
        supervisorChannel.activateTransport();
        refreshResultDelivery();
        fleetStatus?.refresh();
    };
    const asyncCompleteHandler = (payload) => {
        handleComplete(payload);
        refreshResultDelivery();
        refreshActiveAsyncCapacity();
        scheduledRunManager.handleAsyncCompletion(payload);
        fleetStatus?.refresh();
    };
    const eventUnsubscribes = [
        registerRuntimeAgentEventListener(pi),
        registerInspectorEventListener(pi),
        pi.events.on(SUBAGENT_ASYNC_STARTED_EVENT, asyncStartedHandler),
        pi.events.on(SUBAGENT_ASYNC_COMPLETE_EVENT, asyncCompleteHandler),
        pi.events.on(SUBAGENT_PROCESS_TERMINAL_EVENT, () => {
            refreshActiveAsyncCapacity();
            fleetStatus?.refresh();
        }),
        pi.events.on(SUBAGENT_CONTROL_EVENT, controlEventHandler),
        pi.events.on(SUBAGENT_STEERING_NOTICE_EVENT, steeringNoticeHandler),
        herdrStatusBridge.dispose,
        rpcBridge.dispose,
    ];
    pi.on("tool_result", (event, ctx) => {
        if (event.toolName !== "subagent")
            return;
        if (!ctx.hasUI)
            return;
        state.lastUiContext = ctx;
        const activeJobCount = state.asyncJobs.size;
        restoreActiveJobs(ctx);
        if (state.asyncJobs.size > activeJobCount)
            herdrStatusBridge.syncRuns();
        fleetStatus?.setContext(ctx);
        fleetStatus?.refresh();
        if (state.asyncJobs.size > 0) {
            refreshWidget(ctx);
            ensurePoller();
        }
    });
    const cleanupSessionArtifacts = (ctx) => {
        try {
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) {
                cleanupOldArtifacts(getArtifactsDir(sessionFile), artifactCleanupDays);
            }
        }
        catch {
            // Cleanup failures should not block session lifecycle events.
        }
    };
    const suspendWidgetsForCompaction = () => {
        if (state.widgetsSuspended)
            return;
        state.widgetsSuspended = true;
        withLastUiContext((ctx) => ctx.ui.setWidget(WIDGET_KEY, undefined));
        fleetStatus?.refresh();
    };
    const resumeWidgetsAfterCompaction = () => {
        if (!state.widgetsSuspended)
            return;
        state.widgetsSuspended = false;
        withLastUiContext((ctx) => refreshWidget(ctx));
        fleetStatus?.refresh();
    };
    const refreshActiveAsyncCapacity = () => {
        if (!state.currentSessionId) {
            state.activeAsyncCapacity = { used: 0, limit: resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession) ?? 0 };
            return;
        }
        state.activeAsyncCapacity = getActiveAsyncCapacitySnapshot(state.currentSessionId, resolveMaxActiveAsyncRunsPerSession(config.maxActiveAsyncRunsPerSession), { liveWorkflowRunIds: new Set(state.workflowControllers?.keys() ?? []), abandonedSlotReleaseAfterMs: resolveAbandonedSlotReleaseAfterMs(config.capacity?.abandonedSlotReleaseAfterMs) });
    };
    const resetSessionState = (ctx, recovering, previousSessionFile) => {
        state.widgetsSuspended = false;
        state.baseCwd = ctx.cwd;
        goalTurnId = 0;
        const previousRuntimeSessionId = state.currentSessionId;
        resultDeliveryOwnership.claimPredecessor(previousSessionFile, previousRuntimeSessionId);
        state.currentSessionId = resolveCurrentSessionId(ctx.sessionManager);
        state.supervisorOwnerSessionId = ctx.sessionManager.getSessionId() || null;
        transitionResultDelivery();
        state.parentSessionFile = ctx.sessionManager.getSessionFile();
        state.trustedSessionFileRoot = state.parentSessionFile ? path.join(getAgentDir(), "sessions") : undefined;
        state.trustedSessionRoots = [...new Set([
                ...(config.defaultSessionDir ? [path.resolve(expandTilde(config.defaultSessionDir))] : []),
                ...(state.parentSessionFile ? [getSubagentSessionRoot(state.parentSessionFile)] : []),
            ])];
        state.subagentSpawns = {
            sessionId: state.currentSessionId,
            count: 0,
            configuredLimit: resolveMaxSubagentSpawnsPerSession(config.maxSubagentSpawnsPerSession) ?? null,
            granted: 0,
            grantHistory: [],
        };
        const projectPaneOwnerRoot = path.resolve(ctx.cwd);
        restoreHerdrProjectPaneSnapshots(state, [...new Set([...(state.herdrProjectPanes?.keys() ?? []), ...listHerdrProjectPaneRoots(projectPaneOwnerRoot), projectPaneOwnerRoot])]);
        // Root hosts may contain independent sessions, so a process-global parent
        // identity is unsafe. Dedicated child runners retain their launch-owned value.
        if (!process.env[SUBAGENT_CHILD_ENV]) {
            delete process.env[SUBAGENT_PARENT_SESSION_ENV];
        }
        state.lastUiContext = ctx;
        let phaseStartedAt = Date.now();
        refreshActiveAsyncCapacity();
        logSlowPhase("active-capacity", phaseStartedAt);
        phaseStartedAt = Date.now();
        cleanupSessionArtifacts(ctx);
        logSlowPhase("session-artifact-cleanup", phaseStartedAt);
        state.foregroundControls.clear();
        retainedNestedRouteTracker?.clear();
        retainedNestedRouteTracker = undefined;
        executorDeps.trackRetainedNestedRoute = undefined;
        state.lastForegroundControlId = null;
        phaseStartedAt = Date.now();
        resetJobs(ctx);
        logSlowPhase("reset-jobs", phaseStartedAt);
        phaseStartedAt = Date.now();
        restoreForegroundRunHistory(state, { resultsDir: DIRS.results });
        logSlowPhase("foreground-history", phaseStartedAt);
        phaseStartedAt = Date.now();
        restoreActiveJobs(ctx);
        logSlowPhase("active-job-restore", phaseStartedAt);
        phaseStartedAt = Date.now();
        scheduledRunManager.bindSession(ctx);
        logSlowPhase("scheduled-runs", phaseStartedAt);
        phaseStartedAt = Date.now();
        restoreSlashFinalSnapshots(ctx.sessionManager.getEntries());
        logSlowPhase("slash-snapshots", phaseStartedAt);
        phaseStartedAt = Date.now();
        waitSubscriptionManager.restore();
        logSlowPhase("wait-subscriptions", phaseStartedAt);
        phaseStartedAt = Date.now();
        startResultWatcher();
        logSlowPhase("result-watcher-start", phaseStartedAt);
        phaseStartedAt = Date.now();
        primeExistingResults({ triggerTurn: !recovering });
        logSlowPhase("result-prime", phaseStartedAt);
        fleetStatus?.setContext(ctx);
    };
    let runtimeCleaned = false;
    const runtimeEntry = {
        sessionManager: null,
        visibleControlNotices,
        cleanup() {
            if (runtimeCleaned)
                return;
            runtimeCleaned = true;
            releaseHostSessionLiveness();
            releaseHostSessionLiveness = () => { };
            // Workflow continuations retain their launch context; abort them before
            // teardown so a reload cannot launch through a stale context.
            for (const controller of state.workflowControllers?.values() ?? []) {
                if (!controller.signal.aborted)
                    controller.abort(runtimeReplacedAbortReason());
            }
            state.workflowControllers?.clear();
            state.workflowChildStops?.clear();
            clearRuntimeAgentsForPi(pi);
            if (resultIndexCleanupTimer)
                clearTimeout(resultIndexCleanupTimer);
            resultIndexCleanupTimer = undefined;
            if (asyncRetentionTimer)
                clearTimeout(asyncRetentionTimer);
            asyncRetentionTimer = undefined;
            if (modulePreloadTimer)
                clearTimeout(modulePreloadTimer);
            modulePreloadTimer = undefined;
            asyncRetentionAbort.abort();
            stopResultWatcher();
            resultDeliveryOwnership.clear();
            completionNotifier.dispose();
            mainWatchdog.dispose();
            scheduledRunManager.stop();
            supervisorChannel.dispose();
            waitSubscriptionManager.dispose();
            fleetStatus?.dispose();
            disposeAsyncJobTracker();
            for (const timer of state.cleanupTimers.values())
                clearTimeout(timer);
            state.cleanupTimers.clear();
            state.asyncJobs.clear();
            retainedNestedRouteTracker?.clear();
            retainedNestedRouteTracker = undefined;
            executorDeps.trackRetainedNestedRoute = undefined;
            for (const unsubscribe of eventUnsubscribes) {
                try {
                    unsubscribe();
                }
                catch {
                    // Best effort cleanup during shutdown or reload.
                }
            }
            disposeSlashCommands.dispose();
            slashBridge.cancelAll();
            slashBridge.dispose();
            promptTemplateBridge.cancelAll();
            promptTemplateBridge.dispose();
            state.widgetsSuspended = false;
            state.currentSessionId = null;
            state.supervisorOwnerSessionId = null;
            state.statusProjectionSessionId = null;
            state.parentSessionFile = null;
            if (runtimeEntry.sessionManager && runtimeRegistry.bySessionManager.get(runtimeEntry.sessionManager) === runtimeEntry) {
                runtimeRegistry.bySessionManager.delete(runtimeEntry.sessionManager);
            }
            runtimeRegistry.activeEntries.delete(runtimeEntry);
            if (runtimeRegistry.activeEntries.size === 0)
                clearSlashSnapshots();
            try {
                if (state.lastUiContext?.hasUI)
                    state.lastUiContext.ui.setWidget(WIDGET_KEY, undefined);
            }
            catch (error) {
                if (!isStaleExtensionContextError(error))
                    throw error;
            }
            state.lastUiContext = null;
        },
    };
    const installRuntime = (ctx) => {
        if (runtimeCleaned) {
            throw new Error("Cannot restart a cleaned pi-subagents extension runtime; register a new extension instance.");
        }
        const sessionManager = ctx.sessionManager;
        const previousRuntime = runtimeRegistry.bySessionManager.get(sessionManager);
        const existingVisibleControlNotices = runtimeRegistry.visibleControlNoticesBySessionManager.get(sessionManager);
        if (existingVisibleControlNotices) {
            visibleControlNotices = existingVisibleControlNotices;
        }
        else {
            runtimeRegistry.visibleControlNoticesBySessionManager.set(sessionManager, visibleControlNotices);
        }
        runtimeEntry.visibleControlNotices = visibleControlNotices;
        if (runtimeEntry.sessionManager && runtimeEntry.sessionManager !== sessionManager
            && runtimeRegistry.bySessionManager.get(runtimeEntry.sessionManager) === runtimeEntry) {
            runtimeRegistry.bySessionManager.delete(runtimeEntry.sessionManager);
        }
        runtimeEntry.sessionManager = sessionManager;
        runtimeRegistry.bySessionManager.set(sessionManager, runtimeEntry);
        runtimeRegistry.activeEntries.add(runtimeEntry);
        if (previousRuntime && previousRuntime !== runtimeEntry) {
            try {
                previousRuntime.cleanup();
            }
            catch {
                // Best effort cleanup for stale resources from the replaced runtime.
            }
        }
    };
    pi.on("agent_start", () => {
        resumeWidgetsAfterCompaction();
        herdrStatusBridge.agentStarted();
    });
    pi.on("agent_settled", () => {
        resumeWidgetsAfterCompaction();
    });
    pi.on("session_before_compact", (event) => {
        if (event.reason !== "manual")
            suspendWidgetsForCompaction();
    });
    pi.on("session_compact", (event) => {
        if (event.reason !== "manual")
            return;
        const hasActiveAsyncWork = [...state.asyncJobs.values()].some((job) => job.status === "queued" || job.status === "running");
        if (!hasActiveAsyncWork || !withLastUiContext(() => true))
            return;
        pi.sendMessage({
            customType: "subagent-compaction-resume",
            content: "Compaction is complete. Resume the parent task now; background subagent results will arrive separately when ready.",
            display: false,
        }, { triggerTurn: true });
    });
    pi.on("session_start", (event, ctx) => {
        installRuntime(ctx);
        startSessionMaintenance();
        scheduleModulePreload();
        const recovering = event.reason === "startup" || event.reason === "reload" || event.reason === "resume";
        resetSessionState(ctx, recovering, event.previousSessionFile);
        releaseHostSessionLiveness();
        const sessionId = ctx.sessionManager.getSessionId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        const liveness = sessionId
            ? registerPiWebSessionLiveness({
                sessionId,
                ...(sessionFile ? { sessionFile } : {}),
                isActive: () => hasLiveSubagentWork(state) || completionNotifier.hasPendingDelivery(),
            })
            : { registered: false, release: () => { } };
        releaseHostSessionLiveness = liveness.release;
        if (liveness.registered) {
            retainedNestedRouteTracker = createRetainedNestedRouteTracker(state);
            executorDeps.trackRetainedNestedRoute = retainedNestedRouteTracker.track;
        }
        herdrStatusBridge.sessionStarted({
            hasUI: ctx.hasUI === true,
            runs: activeHerdrRuns(),
        });
        rpcBridge.emitReady(ctx);
        supervisorChannel.start();
        supervisorChannel.activateTransport();
    });
    pi.on("session_shutdown", async () => {
        runtimeEntry.cleanup();
        try {
            await disposeChildSessions();
        }
        catch (error) {
            console.error("Failed to dispose in-process child sessions:", error);
        }
        await herdrStatusBridge.flush();
    });
    // Child processes and Herdr panes never load this module; in-process children have no UI.
    pi.on("session_start", (_event, ctx) => void showUpgradeNotice(ctx).catch((error) => console.error("Failed to show the pi-subagents upgrade notice:", error)));
    pi.on("session_start", (_event, ctx) => beginAdvertisement(ctx));
    registerSubagentToolActivation(pi, {
        mode: config.toolActivation,
        advertisedPrompt: async () => {
            await waitForAdvertisement();
            return buildAdvertisedAgentPrompt(advertisedAgents, resolveCurrentSubagentCapabilityCeiling(state.currentSessionId ?? undefined));
        },
    });
}
//# sourceMappingURL=index.js.map