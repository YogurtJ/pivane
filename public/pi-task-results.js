(() => {
    // "Task results" chip above the composer. Collapsed it is one line (unread /
    // active counts); opened it lists one row per result. A row jumps to the
    // matching result card in the transcript; the body is only shown here
    // (bounded, plain text) when that card is not in the loaded transcript.
    const words = (zh, en) => globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
    const label = state => {
        const labels = { completed: words('本轮已结束', 'Run ended'), error: words('执行失败', 'Failed'),
            stopped: words('已中止', 'Stopped'), needs_attention: words('需要处理', 'Needs attention'), uncertain: words('状态待核实', 'Needs verification') };
        return typeof state === 'string' && Object.hasOwn(labels, state) ? labels[state] : labels.uncertain;
    };
    const tone = state => state === 'completed' ? 'done' : state === 'error' ? 'error' : state === 'stopped' ? 'muted' : 'attention';
    const ICONS = { done: 'fa-circle-check', error: 'fa-circle-xmark', muted: 'fa-circle-stop', attention: 'fa-circle-exclamation', active: 'fa-circle-notch' };
    function time(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        const locale = globalThis.PiI18n?.locale || 'zh-CN', now = new Date();
        const options = date.toDateString() === now.toDateString() ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
            : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        return date.toLocaleString(locale, options);
    }
    const oneLine = text => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    function node(tag, className, text) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text != null) element.textContent = text;
        return element;
    }
    function icon(name) { const element = node('i', `fa-solid ${name}`); element.setAttribute('aria-hidden', 'true'); return element; }
    function iconButton(className, iconName, text) {
        const button = node('button', `pi-results-icon ${className}`); button.type = 'button';
        button.title = text; button.setAttribute('aria-label', text); button.append(icon(iconName)); return button;
    }
    // The host link helper appends a text button; restyle it as a compact icon keeping its accessible name.
    function linkIcon(container, target, link, text) {
        const before = container.lastElementChild;
        link(container, target, text);
        const button = container.lastElementChild;
        if (!button || button === before || button.tagName !== 'BUTTON') return;
        button.classList.add('pi-results-icon'); button.title = text; button.setAttribute('aria-label', text);
        button.replaceChildren(icon('fa-arrow-up-right-from-square'));
    }
    function decorate(header, result, link) {
        const title = header.querySelector('strong'); if (title) title.textContent = words('Agent 任务结果', 'Agent task result');
        const meta = node('span', 'pi-agent-thread-meta', `${result.session?.name || result.requestId || ''} · ${label(result.status)}`);
        header.append(meta); link(header, result.session, words('查看完整结果', 'Open complete result'));
    }
    function create({ root, scope, fetch, link, error, locate = () => false }) {
        let enabled = false, flight = false, lastKey = '', revision = 0, rendered = '', marking = false;
        const expanded = new Set();
        root.classList.add('pi-status-chip');
        const summary = node('summary'), title = node('strong'), count = node('span', 'pi-results-count');
        // Narrow rows shared with other chips show only the number that needs attention.
        const short = node('span', 'pi-results-short'); short.setAttribute('aria-hidden', 'true');
        count.setAttribute('role', 'status'); count.setAttribute('aria-live', 'polite'); count.setAttribute('aria-atomic', 'true');
        summary.append(icon('fa-flag-checkered'), title, count, short, icon('fa-chevron-up pi-results-chevron'));
        const body = node('div', 'pi-results-body'), head = node('div', 'pi-results-head');
        const headTitle = node('span', 'pi-results-title'), readAll = node('button', 'pi-results-read-all'); readAll.type = 'button';
        head.append(headTitle, readAll);
        const list = node('div', 'pi-task-results-list'), note = node('p', 'pi-results-note');
        body.append(head, list, note);
        root.append(summary, body); root.hidden = true;
        const key = value => value ? JSON.stringify([value.cwd, value.id, value.generation]) : '';
        function reset() { revision++; rendered = ''; expanded.clear(); root.hidden = true; root.open = false; delete root.dataset.wasOpen; delete root.dataset.state; list.replaceChildren(); }
        function setSummary(text, more = '', brief = '') {
            title.textContent = words('任务结果', 'Task results'); count.textContent = text; short.textContent = brief || text; summary.title = more || text;
        }
        async function markRead(current, ids) {
            for (const deliveryId of ids) {
                if (key(scope()) !== key(current)) return;
                await fetch('/api/pi/agent-threads/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: current.cwd, sourceSessionId: current.id, deliveryId }) });
            }
        }
        async function runMark(current, ids, control) {
            if (marking || !ids.length) return;
            marking = true; if (control) control.disabled = true; readAll.disabled = true;
            try { await markRead(current, ids); }
            catch (e) { if (key(scope()) === key(current)) error(e.message); }
            finally { marking = false; rendered = ''; await refresh(); }
        }
        async function refresh() {
            const current = scope(), nextKey = key(current);
            if (nextKey !== lastKey) { lastKey = nextKey; reset(); }
            if (!enabled || !current) { root.hidden = true; return; }
            if (flight) return;
            flight = true; const captured = revision;
            try {
                const data = await fetch(`/api/pi/agent-threads/results?${new URLSearchParams({ cwd: current.cwd, sourceSessionId: current.id })}`, { signal: AbortSignal.timeout(8000) });
                if (captured !== revision || key(scope()) !== nextKey) return;
                if (data.status === 'indexing') {
                    root.hidden = false; root.dataset.state = 'pending';
                    setSummary(words('正在整理', 'Indexing') + ` ${data.coverage?.checked || 0}/${data.coverage?.files || 0}`,
                        words('正在整理任务记录', 'Preparing task records'), '…');
                    return;
                }
                const results = data.results || [], tasks = data.tasks || [];
                const unread = results.filter(r => !r.read);
                const busy = Boolean(current.busy);
                root.hidden = results.length === 0 && tasks.length === 0;
                root.dataset.state = unread.some(r => tone(r.status) === 'error' || tone(r.status) === 'attention') ? 'attention'
                    : unread.length ? 'unread' : tasks.length ? 'active' : 'idle';
                const parts = [];
                if (unread.length) parts.push(`${unread.length} ` + words('未读', 'unread'));
                if (tasks.length) parts.push(`${tasks.length} ` + words('进行中', 'active'));
                if (!parts.length) parts.push(words('全部已读', 'All read'));
                setSummary(parts.join(' · '), '', unread.length ? String(unread.length) : tasks.length ? String(tasks.length) : '✓');
                const signature = JSON.stringify([results, tasks, busy, [...expanded]]);
                if (signature === rendered) return;
                rendered = signature;
                headTitle.textContent = words(`${results.length} 份结果`, `${results.length} result${results.length === 1 ? '' : 's'}`)
                    + (tasks.length ? ' · ' + words(`${tasks.length} 个进行中`, `${tasks.length} active`) : '');
                readAll.textContent = words('全部标为已读', 'Mark all read');
                readAll.hidden = unread.length === 0;
                readAll.disabled = busy || marking;
                readAll.title = busy ? words('线程空闲后可标记', 'Available when the thread is idle') : '';
                readAll.onclick = () => runMark(current, unread.map(r => r.deliveryId), null);
                const rows = [];
                for (const task of tasks) {
                    const row = node('article', 'pi-task-result'); row.dataset.tone = 'active';
                    const line = node('div', 'pi-task-result-row'), main = node('div', 'pi-task-result-main');
                    const status = task.status === 'waiting' ? words('等待你处理', 'Waiting for you')
                        : task.status === 'saved' ? words('已保存，尚未确认启动', 'Saved; startup not confirmed')
                            : task.status === 'uncertain' ? words('运行状态待核实', 'Run needs verification') : words('正在执行', 'Running');
                    main.append(icon(`${ICONS.active} pi-task-result-icon`), node('span', 'pi-task-result-name', task.session?.name || task.requestId || ''),
                        node('span', 'pi-task-result-meta', status));
                    line.append(main); linkIcon(line, task.session, link, words('查看任务线程', 'Open task thread'));
                    row.append(line); rows.push(row);
                }
                for (const result of results) {
                    const row = node('article', 'pi-task-result'), state = tone(result.status);
                    row.dataset.tone = state; row.dataset.read = String(Boolean(result.read));
                    const line = node('div', 'pi-task-result-row');
                    const main = node('button', 'pi-task-result-main'); main.type = 'button';
                    const metaText = [label(result.status), time(result.completedAt)].filter(Boolean).join(' · ');
                    const name = result.session?.name || result.requestId || '';
                    main.append(icon(`${ICONS[state]} pi-task-result-icon`));
                    if (!result.read) { const dot = node('span', 'pi-task-result-unread'); dot.title = words('未读', 'Unread'); main.append(dot); }
                    main.append(node('span', 'pi-task-result-name', name), node('span', 'pi-task-result-meta', metaText),
                        node('span', 'pi-task-result-preview', oneLine(result.preview) || words('没有正文回复，请查看任务线程。', 'No text reply; open the task thread.')));
                    main.title = words('在对话中查看', 'Show in conversation');
                    const text = node('p', 'pi-task-result-text', (result.preview || words('没有正文回复，请查看任务线程。', 'No text reply; open the task thread.'))
                        + (result.truncated ? '\n\n' + words('此处仅显示部分原文。', 'Showing a partial excerpt.') : ''));
                    text.hidden = !expanded.has(result.deliveryId);
                    row.classList.toggle('expanded', !text.hidden);
                    main.setAttribute('aria-expanded', String(!text.hidden));
                    main.addEventListener('click', () => {
                        if (key(scope()) !== nextKey) return;
                        // Prefer the delivered card in the transcript; it holds the rendered body.
                        if (locate(result.deliveryId)) {
                            root.open = false; delete root.dataset.wasOpen;
                            if (!result.read && !Boolean(scope()?.busy)) void runMark(current, [result.deliveryId], null);
                            return;
                        }
                        if (expanded.has(result.deliveryId)) expanded.delete(result.deliveryId); else expanded.add(result.deliveryId);
                        text.hidden = !expanded.has(result.deliveryId);
                        row.classList.toggle('expanded', !text.hidden);
                        main.setAttribute('aria-expanded', String(!text.hidden));
                        rendered = JSON.stringify([results, tasks, busy, [...expanded]]);
                    });
                    line.append(main);
                    linkIcon(line, result.session, link, words('查看完整结果', 'Open complete result'));
                    if (!result.read) {
                        const button = iconButton('pi-task-result-read', 'fa-check', words('标为已读', 'Mark read'));
                        button.disabled = busy || marking;
                        if (busy) button.title = words('线程空闲后可标记', 'Available when the thread is idle');
                        button.addEventListener('click', () => { if (key(scope()) === nextKey) void runMark(current, [result.deliveryId], button); });
                        line.append(button);
                    }
                    row.append(line, text); rows.push(row);
                }
                list.replaceChildren(...rows);
                note.textContent = words('结果由任务线程自己报告；“本轮已结束”不代表验证通过。', 'Results are reported by the task threads; an ended run does not certify validation.')
                    + (data.truncated ? ' ' + words('只显示最近100份，更早的保留在原线程。', 'Showing the latest 100; older results remain in their threads.') : '');
            } catch (e) {
                if (captured === revision && key(scope()) === nextKey) {
                    root.hidden = false; root.dataset.state = 'attention';
                    setSummary(words('暂不可用', 'Unavailable'), words('任务结果暂不可用，将自动重试', 'Task results unavailable; retrying'), '!');
                }
            } finally { flight = false; }
        }
        return { refresh, reset, setEnabled(value) { enabled = value; if (!value) reset(); } };
    }
    window.PiTaskResults = { create, decorate };
})();
