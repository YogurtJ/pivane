(() => {
    const words = (zh, en) => globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
    const label = state => {
        const labels = { completed: words('本轮已结束', 'Run ended'), error: words('执行失败', 'Failed'),
            stopped: words('已中止', 'Stopped'), needs_attention: words('需要处理', 'Needs attention'), uncertain: words('状态待核实', 'Needs verification') };
        return typeof state === 'string' && Object.hasOwn(labels, state) ? labels[state] : labels.uncertain;
    };
    function decorate(header, result, link) {
        const title = header.querySelector('strong'); if (title) title.textContent = words('Agent 任务结果', 'Agent task result');
        const meta = document.createElement('span'); meta.className = 'pi-agent-thread-meta';
        meta.textContent = `${result.session?.name || result.requestId || ''} · ${label(result.status)}`;
        header.append(meta); link(header, result.session, words('查看完整结果', 'Open complete result'));
    }
    function create({ root, scope, fetch, link, error }) {
        let enabled = false, flight = false, lastKey = '', revision = 0, rendered = '';
        const summary = document.createElement('summary'), body = document.createElement('div');
        body.className = 'pi-task-results-list'; root.append(summary, body); root.hidden = true;
        const key = value => value ? JSON.stringify([value.cwd, value.id, value.generation]) : '';
        function reset() { revision++; rendered = ''; root.hidden = true; root.open = false; body.replaceChildren(); }
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
                    root.hidden = false;
                    summary.textContent = words('正在整理任务记录', 'Preparing task records') + ` · ${data.coverage?.checked || 0}/${data.coverage?.files || 0}`;
                    return;
                }
                const results = data.results || [], tasks = data.tasks || [], signature = JSON.stringify([results, tasks, Boolean(current.busy)]);
                root.hidden = results.length === 0 && tasks.length === 0;
                summary.textContent = words('任务结果', 'Task results') + ` · ${results.filter(r => !r.read).length} ` + words('未读', 'unread')
                    + (tasks.length ? ` · ${tasks.length} ` + words('进行中', 'active') : '');
                if (signature === rendered) return;
                rendered = signature; body.replaceChildren();
                for (const result of results) {
                    const article = document.createElement('article'); article.className = 'pi-task-result';
                    const header = document.createElement('header'), strong = document.createElement('strong'); header.append(strong);
                    decorate(header, result, link);
                    const text = document.createElement('p'); text.textContent = result.preview || words('没有正文回复，请查看任务线程。', 'No text reply; open the task thread.');
                    article.append(header, text);
                    if (result.truncated) { const note = document.createElement('small'); note.textContent = words('此处仅显示部分原文。', 'Showing a partial excerpt.'); article.append(note); }
                    const reported = document.createElement('small'); reported.textContent = words('来自任务线程的报告；结束状态不代表验证通过。', 'Reported by the task thread; an ended run does not certify validation.'); article.append(reported);
                    if (!result.read) {
                        const button = document.createElement('button'); button.type = 'button'; button.textContent = words('标为已读', 'Mark read');
                        button.disabled = Boolean(current.busy);
                        button.addEventListener('click', async () => {
                            if (key(scope()) !== nextKey) return;
                            button.disabled = true;
                            try { await fetch('/api/pi/agent-threads/read', { method: 'POST', body: JSON.stringify({ cwd: current.cwd, sourceSessionId: current.id, deliveryId: result.deliveryId }) }); rendered = ''; await refresh(); }
                            catch (e) { if (key(scope()) === nextKey) { error(e.message); button.disabled = false; } }
                        }); article.append(button);
                    }
                    body.append(article);
                }
                for (const task of tasks) {
                    const row = document.createElement('article'); row.className = 'pi-task-result';
                    const text = document.createElement('p');
                    const status = task.status === 'waiting' ? words('等待你处理', 'Waiting for you')
                        : task.status === 'saved' ? words('已保存，尚未确认启动', 'Saved; startup not confirmed')
                            : task.status === 'uncertain' ? words('运行状态待核实', 'Run needs verification') : words('正在执行', 'Running');
                    text.textContent = `${task.session?.name || task.requestId} · ${status}`;
                    row.append(text); link(row, task.session, words('查看任务线程', 'Open task thread')); body.append(row);
                }
                if (data.truncated) { const more = document.createElement('p'); more.textContent = words('显示最近100份结果；更早结果保留在原线程。', 'Showing the latest 100 results; older results remain in their threads.'); body.append(more); }
            } catch (e) {
                if (captured === revision && key(scope()) === nextKey) {
                    root.hidden = false; summary.textContent = words('任务结果暂不可用，将自动重试', 'Task results unavailable; retrying');
                }
            } finally { flight = false; }
        }
        return { refresh, reset, setEnabled(value) { enabled = value; if (!value) reset(); } };
    }
    window.PiTaskResults = { create, decorate };
})();
