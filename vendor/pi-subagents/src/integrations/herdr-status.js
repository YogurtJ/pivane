import { SUBAGENT_ASYNC_COMPLETE_EVENT, SUBAGENT_ASYNC_STARTED_EVENT, SUBAGENT_CONTROL_EVENT, } from "../shared/types.js";
import { previewDisplayText, sanitizeDisplayText } from "../shared/display-text.js";
const DEFAULT_SOURCE = "pi-subagents:herdr";
const DEFAULT_TTL_MS = 120_000;
const DEFAULT_REFRESH_MS = 45_000;
const MAX_TASK_LABEL_CHARS = 80;
const MAX_TITLE_TASK_CHARS = 42;
const MAX_WORKFLOW_LABEL_NODES = 128;
const MAX_WORKFLOW_LABEL_DEPTH = 8;
let metadataReportSeq = Date.now() * 1000;
function nextMetadataReportSeq() {
    metadataReportSeq = Math.max(metadataReportSeq + 1, Date.now() * 1000);
    return metadataReportSeq;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function boundedTaskLabel(value, maxChars = MAX_TASK_LABEL_CHARS) {
    if (typeof value !== "string")
        return undefined;
    const normalized = sanitizeDisplayText(value).trim();
    if (!normalized)
        return undefined;
    return previewDisplayText(normalized, maxChars);
}
function workflowTaskLabel(data) {
    const explicit = boundedTaskLabel(data.taskLabel);
    if (explicit)
        return explicit;
    if (!isRecord(data.workflowGraph) || !Array.isArray(data.workflowGraph.nodes))
        return undefined;
    const currentNodeId = typeof data.workflowGraph.currentNodeId === "string" ? data.workflowGraph.currentNodeId : undefined;
    const nodes = [];
    const collect = (values, depth) => {
        if (depth > MAX_WORKFLOW_LABEL_DEPTH || nodes.length >= MAX_WORKFLOW_LABEL_NODES)
            return;
        for (const value of values) {
            if (nodes.length >= MAX_WORKFLOW_LABEL_NODES)
                return;
            if (!isRecord(value))
                continue;
            nodes.push(value);
            if (Array.isArray(value.children))
                collect(value.children, depth + 1);
        }
    };
    collect(data.workflowGraph.nodes, 0);
    const current = currentNodeId ? nodes.find((node) => node.id === currentNodeId) : undefined;
    const active = current ?? nodes.find((node) => node.status === "running") ?? nodes.find((node) => node.status === "pending");
    return boundedTaskLabel(active?.label);
}
function startedRun(data) {
    if (!isRecord(data) || typeof data.id !== "string" || !data.id)
        return undefined;
    const taskLabel = workflowTaskLabel(data);
    return {
        id: data.id,
        ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
        ...(Array.isArray(data.agents) && data.agents.every((agent) => typeof agent === "string") ? { agents: data.agents } : {}),
        ...(taskLabel ? { taskLabel } : {}),
    };
}
function completedRunId(data) {
    if (!isRecord(data))
        return undefined;
    const id = typeof data.runId === "string" ? data.runId : data.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}
function attentionNotice(data) {
    if (!isRecord(data) || data.source !== "async" || !isRecord(data.event))
        return undefined;
    if (data.event.type !== "needs_attention" || typeof data.event.runId !== "string" || !data.event.runId)
        return undefined;
    const label = typeof data.noticeText === "string" && data.noticeText
        ? data.noticeText
        : typeof data.event.message === "string" && data.event.message
            ? data.event.message
            : "subagent needs attention";
    return { runId: data.event.runId, label };
}
export function registerHerdrStatusBridge(options) {
    const env = options.env ?? process.env;
    const paneId = env.HERDR_PANE_ID;
    const enabled = env.HERDR_ENV === "1" && typeof paneId === "string" && paneId.length > 0;
    const runHerdr = options.runHerdr;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
    const timers = options.timers ?? { setInterval, clearInterval };
    const runs = new Map();
    const attentionLabels = new Map();
    const acknowledgedAttention = new Set();
    const subscriptions = [];
    let rootSession = false;
    let published = false;
    let busyRaised = false;
    let busyLabel;
    let blockedRaised = false;
    let blockedLabel;
    let disposed = false;
    let pendingReport;
    let draining = false;
    let drainPromise = Promise.resolve();
    let refreshTimer;
    const activeAgentNames = () => [...new Set([...runs.values()].flatMap((run) => run.agents?.length ? run.agents : run.agent ? [run.agent] : []))];
    const activeSubagentCount = () => [...runs.values()].reduce((total, run) => total + Math.max(1, run.agents?.length ?? (run.agent ? 1 : 0)), 0);
    const activeTaskLabel = () => [...runs.values()].reverse().find((run) => run.taskLabel)?.taskLabel;
    const label = (includeAttention = false) => {
        const agents = activeAgentNames();
        const activeCount = activeSubagentCount();
        const who = agents.length > 0
            ? ` (${agents.slice(0, 3).join(", ")}${agents.length > 3 ? ", …" : ""})`
            : "";
        const panes = Math.max(0, options.getProjectPaneCount?.() ?? 0);
        const paneText = panes > 0 ? ` · ${panes} pane${panes === 1 ? "" : "s"}` : "";
        const task = activeTaskLabel();
        const taskText = task ? ` · ${task}` : "";
        const attention = includeAttention && attentionLabels.size > 0 ? " ⚠" : "";
        return `⏳ ${activeCount} subagent${activeCount === 1 ? "" : "s"}${who}${paneText}${taskText}${attention}`;
    };
    const titleSuffix = () => {
        if (runs.size === 0)
            return undefined;
        const agentNames = activeAgentNames();
        const activeCount = activeSubagentCount();
        const task = boundedTaskLabel(activeTaskLabel(), MAX_TITLE_TASK_CHARS);
        const target = task ?? (activeCount === 1 && agentNames.length === 1 ? agentNames[0] : String(activeCount));
        return `⏳${target}${attentionLabels.size > 0 ? "⚠" : ""}`;
    };
    const enqueue = (args) => {
        pendingReport = args;
        if (draining)
            return;
        draining = true;
        drainPromise = (async () => {
            while (pendingReport) {
                const next = pendingReport;
                pendingReport = undefined;
                try {
                    await runHerdr(next);
                }
                catch {
                    // Herdr integration is best effort; a later state transition or TTL
                    // refresh retries with the newest desired snapshot.
                }
            }
        })().finally(() => {
            draining = false;
        });
    };
    const publish = () => {
        if (!enabled || !rootSession || disposed || !paneId)
            return;
        if (runs.size === 0 && !published)
            return;
        const seq = String(nextMetadataReportSeq());
        if (runs.size === 0) {
            published = false;
            enqueue([
                "pane", "report-metadata", paneId,
                "--source", DEFAULT_SOURCE,
                "--agent", "pi",
                "--applies-to-source", "herdr:pi",
                "--clear-state-labels",
                "--clear-token", "summary",
                "--clear-token", "title-suffix",
                "--seq", seq,
            ]);
            return;
        }
        const text = label(true);
        const suffix = titleSuffix();
        published = true;
        enqueue([
            "pane", "report-metadata", paneId,
            "--source", DEFAULT_SOURCE,
            "--agent", "pi",
            "--applies-to-source", "herdr:pi",
            "--state-label", `idle=${text}`,
            "--state-label", `done=${text}`,
            "--state-label", `working=${text}`,
            "--token", `summary=${text}`,
            ...(suffix ? ["--token", `title-suffix=${suffix}`] : []),
            "--ttl-ms", String(ttlMs),
            "--seq", seq,
        ]);
    };
    const syncRefreshTimer = () => {
        if (runs.size > 0 && refreshMs > 0 && !refreshTimer) {
            refreshTimer = timers.setInterval(() => refresh(), refreshMs);
            refreshTimer.unref?.();
        }
        else if ((runs.size === 0 || refreshMs <= 0) && refreshTimer) {
            timers.clearInterval(refreshTimer);
            refreshTimer = undefined;
        }
    };
    const syncBusy = () => {
        if (!enabled || !rootSession || disposed)
            return;
        if (runs.size > 0) {
            const text = label();
            if (busyRaised && busyLabel === text)
                return;
            if (busyRaised)
                options.events.emit("herdr:busy", { active: false });
            busyRaised = true;
            busyLabel = text;
            options.events.emit("herdr:busy", { active: true, label: text });
            return;
        }
        if (busyRaised) {
            busyRaised = false;
            busyLabel = undefined;
            options.events.emit("herdr:busy", { active: false });
        }
    };
    const syncBlocked = () => {
        if (!enabled || !rootSession || disposed)
            return;
        const nextLabel = [...attentionLabels.values()].at(-1);
        if (nextLabel !== undefined) {
            if (blockedRaised && blockedLabel === nextLabel)
                return;
            // Herdr's sibling overlay contract is counted. Lower before changing
            // the active label so this bridge continues to own exactly one count.
            if (blockedRaised)
                options.events.emit("herdr:blocked", { active: false });
            blockedRaised = true;
            blockedLabel = nextLabel;
            options.events.emit("herdr:blocked", { active: true, label: nextLabel });
            return;
        }
        if (blockedRaised) {
            blockedRaised = false;
            blockedLabel = undefined;
            options.events.emit("herdr:blocked", { active: false });
        }
    };
    const clearAttention = () => {
        attentionLabels.clear();
        syncBlocked();
        publish();
    };
    const raiseAttention = (runId, labelText) => {
        if (!rootSession || attentionLabels.has(runId))
            return;
        acknowledgedAttention.delete(runId);
        attentionLabels.set(runId, labelText);
        syncBlocked();
        publish();
    };
    const replaceRuns = (nextRuns) => {
        const nextAttention = new Map();
        const activeIds = new Set();
        runs.clear();
        for (const run of nextRuns) {
            if (!run || typeof run.id !== "string" || !run.id)
                continue;
            activeIds.add(run.id);
            const taskLabel = boundedTaskLabel(run.taskLabel);
            const { taskLabel: _rawTaskLabel, ...sanitizedRun } = run;
            runs.set(run.id, { ...sanitizedRun, ...(taskLabel ? { taskLabel } : {}) });
            if (!run.needsAttention) {
                acknowledgedAttention.delete(run.id);
            }
            else if (!acknowledgedAttention.has(run.id)) {
                nextAttention.set(run.id, run.attentionLabel || attentionLabels.get(run.id) || "subagent needs attention");
            }
        }
        for (const id of acknowledgedAttention) {
            if (!activeIds.has(id))
                acknowledgedAttention.delete(id);
        }
        attentionLabels.clear();
        for (const [id, labelText] of nextAttention)
            attentionLabels.set(id, labelText);
        syncBusy();
        syncRefreshTimer();
        syncBlocked();
        publish();
    };
    const refresh = () => {
        if (!options.getRuns) {
            publish();
            return;
        }
        try {
            replaceRuns(options.getRuns());
        }
        catch {
            // Keep the last known active projection and retry on the next refresh.
            publish();
        }
    };
    const subscribe = (event, handler) => {
        const unsubscribe = options.events.on(event, handler);
        if (typeof unsubscribe === "function")
            subscriptions.push(unsubscribe);
    };
    if (enabled) {
        subscribe(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
            if (!rootSession)
                return;
            const run = startedRun(data);
            if (!run)
                return;
            acknowledgedAttention.delete(run.id);
            runs.set(run.id, run);
            syncBusy();
            syncRefreshTimer();
            publish();
        });
        subscribe(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
            if (!rootSession)
                return;
            const id = completedRunId(data);
            if (!id || !runs.delete(id))
                return;
            acknowledgedAttention.delete(id);
            if (attentionLabels.delete(id))
                syncBlocked();
            syncBusy();
            syncRefreshTimer();
            publish();
        });
        subscribe(SUBAGENT_CONTROL_EVENT, (data) => {
            if (!rootSession)
                return;
            const notice = attentionNotice(data);
            if (!notice || !runs.has(notice.runId))
                return;
            raiseAttention(notice.runId, notice.label);
        });
    }
    return {
        agentStarted() {
            for (const id of attentionLabels.keys())
                acknowledgedAttention.add(id);
            clearAttention();
        },
        sessionStarted({ hasUI, runs: restoredRuns }) {
            if (!enabled || disposed || hasUI !== true)
                return;
            rootSession = true;
            replaceRuns(restoredRuns);
        },
        syncRuns() {
            if (!enabled || !rootSession || disposed)
                return;
            refresh();
        },
        async flush() {
            while (draining || pendingReport)
                await drainPromise;
        },
        dispose() {
            if (disposed)
                return;
            clearAttention();
            acknowledgedAttention.clear();
            runs.clear();
            syncBusy();
            syncRefreshTimer();
            publish();
            for (const unsubscribe of subscriptions)
                unsubscribe();
            disposed = true;
        },
    };
}
//# sourceMappingURL=herdr-status.js.map