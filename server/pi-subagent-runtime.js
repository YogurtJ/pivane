// Supervisor-side projection of pi-subagents host integration data. The worker
// extension is trusted to relay, not to shape browser-visible structures.
const SNAPSHOT_PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
const SNAPSHOT_KIND = 'pi-subagents.async-status-snapshot';
const ASYNC_WIDGET = 'subagent-async';
const INSPECT_WIDGET = 'subagent-inspect';
const STATES = new Set(['queued', 'running', 'complete', 'failed', 'partial', 'paused', 'stopped', 'rejected']);
const KINDS = new Set(['subagent', 'workflow', 'step', 'host-step']);
const METHODS = new Set(['status', 'cost', 'steer', 'stop', 'interrupt', 'resume']);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const str = (value, limit = 200) => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, limit) : undefined;
const time = value => Number.isFinite(value) && value > 0 && value < 1e14 ? value : undefined;
const count = value => Number.isInteger(value) && value >= 0 && value < 1e9 ? value : undefined;
const clean = object => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

function node(raw, depth) {
    if (!raw || typeof raw !== 'object' || !STATES.has(raw.state) || !KINDS.has(raw.kind)) return null;
    const id = str(raw.id, 256);
    if (!id) return null;
    const activity = raw.activity && typeof raw.activity === 'object' ? clean({
        state: str(raw.activity.state, 40), currentTool: str(raw.activity.currentTool, 80),
        lastActivityAt: time(raw.activity.lastActivityAt), currentToolStartedAt: time(raw.activity.currentToolStartedAt),
        turnCount: count(raw.activity.turnCount), toolCount: count(raw.activity.toolCount)
    }) : undefined;
    const children = depth < 4 && Array.isArray(raw.children)
        ? raw.children.slice(0, 12).map(child => node(child, depth + 1)).filter(Boolean) : [];
    return clean({ id, kind: raw.kind, label: str(raw.label) || id, state: raw.state,
        startedAt: time(raw.startedAt), updatedAt: time(raw.updatedAt), endedAt: time(raw.endedAt),
        activity: activity && Object.keys(activity).length ? activity : undefined,
        children: children.length ? children : undefined });
}

function normalizeSnapshot(raw) {
    if (!raw || raw.kind !== SNAPSHOT_KIND || raw.version !== 1 || !Array.isArray(raw.runs)) return null;
    const runs = raw.runs.slice(0, 20).map(run => node(run, 0)).filter(Boolean);
    return { version: 1, generatedAt: time(raw.generatedAt) || Date.now(), runs,
        omitted: { runs: count(raw.omitted?.runs) || 0, children: count(raw.omitted?.children) || 0 } };
}

// Returns undefined for foreign widgets, null to clear, or a normalized snapshot.
// Parsing happens on the raw line: generic widgets are truncated for display.
function snapshotWidget(event) {
    if (event?.widgetKey === INSPECT_WIDGET) return { ignore: true };
    if (event?.widgetKey !== ASYNC_WIDGET) return undefined;
    if (event.widgetLines == null) return { snapshot: null };
    const line = Array.isArray(event.widgetLines) && event.widgetLines.length === 1 ? event.widgetLines[0] : null;
    if (typeof line !== 'string' || !line.startsWith(SNAPSHOT_PREFIX) || line.length > 256 * 1024) return undefined;
    try { const snapshot = normalizeSnapshot(JSON.parse(line.slice(SNAPSHOT_PREFIX.length))); return snapshot ? { snapshot } : { ignore: true }; }
    catch { return { ignore: true }; }
}

function backgroundWork(raw, sessionId) {
    if (!raw || raw.version !== 1 || raw.sessionId !== sessionId || typeof raw.active !== 'boolean') return null;
    return { supported: raw.supported === true, active: raw.active,
        sources: Array.isArray(raw.sources) ? raw.sources.map(source => str(source, 64)).filter(Boolean).slice(0, 8) : [] };
}

function validateControl(input) {
    const { method, params = {} } = input || {};
    if (!METHODS.has(method)) throw new Error('不支持此子 Agent 操作');
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('子 Agent 操作参数无效');
    const allowed = { status: ['id', 'index', 'view', 'lines'], cost: [], steer: ['id', 'index', 'message', 'mode'],
        stop: ['id'], interrupt: ['id', 'index'], resume: ['id', 'index', 'message'] }[method];
    if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error('子 Agent 操作包含不支持的参数');
    if (method !== 'cost' && method !== 'status' && !ID.test(params.id || '')) throw new Error('请选择有效的子 Agent 运行');
    if (params.id !== undefined && !ID.test(params.id)) throw new Error('子 Agent 运行标识无效');
    if (params.index !== undefined && !(Number.isInteger(params.index) && params.index >= 0 && params.index < 1000)) throw new Error('子任务序号无效');
    if (['steer', 'resume'].includes(method) && !(typeof params.message === 'string' && params.message.trim() && params.message.length <= 8000)) throw new Error('请输入 1–8000 个字符的说明');
    if (params.mode !== undefined && !['steer', 'follow_up'].includes(params.mode)) throw new Error('引导方式无效');
    if (params.view !== undefined && params.view !== 'transcript') throw new Error('不支持此查看方式');
    if (params.lines !== undefined && !(Number.isInteger(params.lines) && params.lines > 0 && params.lines <= 500)) throw new Error('记录行数无效');
    if (params.view && !params.id) throw new Error('查看记录需要指定运行');
    return { method, params: method === 'cost' ? undefined : params };
}

function usage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const cost = typeof raw.cost === 'number' ? raw.cost : raw.cost?.total;
    return clean({ input: count(raw.input), output: count(raw.output), cacheRead: count(raw.cacheRead), cacheWrite: count(raw.cacheWrite),
        turns: count(raw.turns), cost: Number.isFinite(cost) && cost >= 0 ? cost : undefined });
}

function controlResult(method, data) {
    if (!data || typeof data !== 'object') return {};
    if (method === 'cost') {
        const cost = data.cost;
        return { cost: cost ? { total: usage(cost.total), childTotal: usage(cost.childTotal), parent: usage(cost.parent),
            unresolvedAsyncChildren: count(cost.unresolvedAsyncChildren) || 0,
            children: (Array.isArray(cost.children) ? cost.children : []).slice(0, 100).map(child => ({ label: str(child?.label) || '', agent: str(child?.agent, 80), usage: usage(child?.usage) })) } : null };
    }
    return clean({ text: str(data.text, 256 * 1024), state: str(data.state, 40), isError: data.isError === true || undefined,
        snapshot: method === 'status' && data.asyncSnapshot ? normalizeSnapshot(data.asyncSnapshot) || undefined : undefined });
}

module.exports = { snapshotWidget, normalizeSnapshot, backgroundWork, validateControl, controlResult, ASYNC_WIDGET };
