((root, factory) => {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PiNestedTools = api;
})(typeof window === 'object' ? window : globalThis, root => {
    const LIMIT = 256, DEPTH = 8, TEXT = 32768;
    const t = (s, ...args) => root.PiI18n?.t?.(s, ...args) ?? s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
    const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 1024;
    const bounded = value => typeof value === 'string' ? value.slice(0, TEXT) + (value.length > TEXT ? '\n' + t('显示已截断') : '') : '';
    function argsText(args) {
        try { return bounded(JSON.stringify(args, null, 2) || ''); } catch { return ''; }
    }
    // Pi 0.99 assigns <caller>/<positive integer>, and flattens descendants into the
    // model-issued parent's nestedCalls. No arbitrary id-prefix inference is allowed.
    function records(parentId, record) {
        if (!validId(parentId) || !Array.isArray(record?.calls)) return { calls: [], complete: false };
        const source = record.calls.slice(0, LIMIT), ids = new Map();
        for (const call of source) if (validId(call?.id)) ids.set(call.id, (ids.get(call.id) || 0) + 1);
        const calls = [], accepted = new Set([parentId]);
        let argumentBytes = 0, complete = record.complete === true;
        // Native records are start ordered: a child cannot precede its caller.
        for (const call of source) {
            if (ids.get(call?.id) !== 1 || !call.id.startsWith(parentId + '/')) continue;
            const suffix = call.id.slice(parentId.length + 1).split('/');
            if (suffix.length > DEPTH || !suffix.every(s => /^[1-9]\d{0,8}$/.test(s))) continue;
            const parent = call.id.slice(0, call.id.lastIndexOf('/'));
            if (!accepted.has(parent) || typeof call.name !== 'string' || !call.name || call.name.length > 256) continue;
            accepted.add(call.id);
            let args, omitted = call.argumentsBytes;
            try {
                if (call.arguments !== undefined) {
                    const json = JSON.stringify(call.arguments), bytes = new TextEncoder().encode(json).length;
                    if (call.arguments && typeof call.arguments === 'object' && !Array.isArray(call.arguments)
                        && bytes <= 8192 && argumentBytes + bytes <= 32768) { args = call.arguments; argumentBytes += bytes; }
                    else { omitted = bytes; complete = false; }
                }
            } catch { complete = false; }
            if (omitted !== undefined || call.status === 'unfinished') complete = false;
            calls.push({ id: call.id, parent, name: call.name, arguments: args,
                argumentsBytes: omitted, status: ['ok', 'error', 'unfinished'].includes(call.status) ? call.status : 'unfinished',
                durationMs: Number.isSafeInteger(call.durationMs) && call.durationMs >= 0 ? call.durationMs : null,
                error: typeof call.error === 'string' ? call.error.slice(0, 500) : '' });
        }
        return { calls, complete: complete && source.length === record.calls.length && calls.length === source.length };
    }
    function mutations(parentId, record, policy) {
        if (!Array.isArray(record?.calls) || record.calls.length > LIMIT) return [];
        const normalized = records(parentId, record);
        return normalized.calls.filter(call => call.status === 'ok' && ['edit', 'write'].includes(call.name)
            && typeof call.arguments?.path === 'string' && call.arguments.path.trim() && call.arguments.path.length <= 4096
            && !/[\x00-\x1f\x7f]/.test(call.arguments.path) && !policy.restricted(call.arguments.path)
            && (call.name !== 'write' || typeof call.arguments.content === 'string'
                && new TextEncoder().encode(call.arguments.content).length <= policy.maxBytes));
    }
    function container(row) {
        let host = row.querySelector(':scope > .pi-nested-tools');
        if (!host) { host = root.document.createElement('section'); host.className = 'pi-nested-tools'; row.append(host); }
        return host;
    }
    function paint(row) {
        const data = row._piNested;
        if (!data) return;
        const host = container(row), opened = new Set([...host.querySelectorAll('details[open]')].map(node => node.dataset.nestedId));
        host.replaceChildren();
        const note = root.document.createElement('p'); note.className = 'pi-nested-note';
        note.textContent = data.persisted ? t('嵌套调用 · 原生记录不保存输出；编辑差异不可恢复') : t('嵌套调用 · 实时输出仅在本页保留');
        if (!data.complete) note.append(' · ' + t('记录不完整或仍在执行'));
        host.append(note);
        const parents = new Map([[row.dataset.toolId, host]]);
        for (const call of data.calls.values()) {
            const owner = parents.get(call.parent); if (!owner) continue;
            const node = root.document.createElement('details'); node.className = 'pi-nested-call'; node.dataset.nestedId = call.id;
            node.dataset.detailKey = `nested:${call.id}`;
            const summary = root.document.createElement('summary');
            const name = root.document.createElement('strong'); name.textContent = call.name;
            const state = root.document.createElement('span');
            state.textContent = t(({ ok: '完成', error: '失败', unfinished: '未完成' })[call.status]) + (call.durationMs != null ? ` · ${call.durationMs}ms` : '');
            summary.append(name, state); node.append(summary); owner.append(node); parents.set(call.id, node);
            let loaded = false;
            const load = () => {
                if (loaded) return; loaded = true;
                const detail = root.document.createElement('div'); detail.className = 'pi-nested-detail';
                const args = root.document.createElement('pre'); args.textContent = call.arguments === undefined
                    ? t('参数未保留{0}', Number.isSafeInteger(call.argumentsBytes) ? ` (${call.argumentsBytes} bytes)` : '') : argsText(call.arguments);
                const output = root.document.createElement('pre'); output.textContent = data.persisted ? t('原生记录未保存此调用的输出')
                    : call.output || t('尚无输出');
                if (call.error) output.append('\n' + call.error);
                detail.append(args, output); node.append(detail);
            };
            summary.addEventListener('click', load); node.addEventListener('toggle', () => { if (node.open) load(); });
            node.open = opened.has(call.id); if (node.open) load();
        }
    }
    function persisted(row, record) {
        if (!record) { delete row._piNested; row.querySelector(':scope > .pi-nested-tools')?.remove(); return; }
        const normalized = records(row.dataset.toolId, record);
        row._piNested = { persisted: true, complete: normalized.complete, calls: new Map(normalized.calls.map(call => [call.id, call])) };
        paint(row);
    }
    function live(rows, event) {
        if (!validId(event.parentToolCallId) || !validId(event.toolCallId)) return null;
        // Nested ids are never put in the top-level toolRows map. Missing/ambiguous
        // parents fail closed instead of appending orphan rows to the transcript.
        let owner = null;
        for (const row of rows.values()) {
            if (!row?.isConnected) continue;
            if (row.dataset.toolId === event.parentToolCallId || row._piNested?.calls.has(event.parentToolCallId)) {
                if (owner) return null; owner = row;
            }
        }
        if (!owner || rows.has(event.toolCallId)) return null;
        let data = owner._piNested;
        if (data?.persisted) return null; // Late frames cannot overwrite native truth.
        data ||= owner._piNested = { persisted: false, complete: false, calls: new Map() };
        const previous = data.calls.get(event.toolCallId);
        if (previous && (previous.parent !== event.parentToolCallId || previous.name !== event.toolName)) return null;
        if (!previous && (data.calls.size >= LIMIT || !['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type))) return null;
        const probe = records(owner.dataset.toolId, { calls: [...data.calls.values(), ...(previous ? [] : [{ id: event.toolCallId, name: event.toolName, status: 'unfinished' }])], complete: false });
        if (!probe.calls.some(call => call.id === event.toolCallId && call.parent === event.parentToolCallId)) return null;
        if (previous?.status !== undefined && previous.status !== 'unfinished') return null;
        const result = event.result || event.partialResult;
        const output = Array.isArray(result?.content) ? result.content.filter(b => b.type === 'text').map(b => bounded(b.text)).join('\n').slice(0, TEXT) : '';
        const call = { ...previous, id: event.toolCallId, parent: event.parentToolCallId, name: event.toolName,
            arguments: event.args === undefined ? previous?.arguments : event.args,
            status: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'ok' : 'unfinished', output: output || previous?.output || '' };
        // Live arguments/output have an independent display budget; never retain
        // an unbounded result or the raw event object in page memory.
        const serialized = argsText(call.arguments);
        try { call.arguments = serialized ? JSON.parse(serialized) : undefined; } catch { call.arguments = undefined; }
        data.calls.set(call.id, call); paint(owner); return owner;
    }
    return { records, mutations, persisted, live, limits: { calls: LIMIT, depth: DEPTH, text: TEXT } };
});
