(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(text, ...values) : text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? '');
    const STATES = {
        queued: ['排队中', 'fa-regular fa-clock', 'active'], running: ['运行中', 'fa-solid fa-circle-notch', 'active'],
        paused: ['已暂停', 'fa-solid fa-pause', 'attention'], complete: ['已完成', 'fa-regular fa-circle-check', 'done'],
        partial: ['部分完成', 'fa-solid fa-circle-half-stroke', 'attention'], failed: ['失败', 'fa-solid fa-circle-exclamation', 'error'],
        stopped: ['已停止', 'fa-regular fa-circle-stop', 'muted'], rejected: ['未启动', 'fa-solid fa-ban', 'error']
    };
    const ACTIVE = new Set(['queued', 'running']);
    // pi-subagents reports each step's model only in targeted status text, e.g.
    // "Step 1: auth check (reviewer) running (claude-opus-4 · thinking high), 3 turns".
    const STEP_LINE = /^(Step \d+(?:\/\d+)?(?: Agent \d+\/\d+)?|Agent \d+\/\d+|Workflow child [^:]{1,120}): (?:\[[^\]]{0,80}\] )?(.+?) (pending|queued|running|complete|completed|failed|paused|stopped|skipped|cancelled|canceled|interrupted|rejected|partial|detached)(?: \(([^()]{1,300})\))?(?:,|$)/;
    function stepModels(text) {
        const steps = [];
        for (const line of String(text || '').split('\n')) {
            const match = STEP_LINE.exec(line.trimEnd());
            if (!match) continue;
            const [, step, display, state, detail = ''] = match;
            const named = /^(.*) \(([^()]+)\)$/.exec(display);
            const parts = detail.split(' · ').map(part => part.trim()).filter(Boolean);
            const thinking = parts.find(part => /^thinking \S+$/.test(part));
            steps.push({ step, name: named ? named[1] : display, agent: named ? named[2] : '', state,
                model: parts.find(part => part !== thinking) || '', thinking: thinking ? thinking.slice(9) : '' });
            if (steps.length >= 50) break;
        }
        return steps;
    }
    const RESUMABLE = new Set(['paused', 'stopped', 'failed', 'partial', 'complete']);
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    };
    const icon = className => { const node = el('i', className); node.setAttribute('aria-hidden', 'true'); return node; };
    const duration = ms => {
        const seconds = Math.max(0, Math.round(ms / 1000));
        if (seconds < 60) return t('{0} 秒', seconds);
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return t('{0} 分 {1} 秒', minutes, seconds % 60);
        return t('{0} 小时 {1} 分', Math.floor(minutes / 60), minutes % 60);
    };
    const tokens = value => Number.isFinite(value) ? value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(value) : '—';
    const money = value => Number.isFinite(value) ? `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}` : '—';

    class PiSubagentRuns {
        constructor(root, options) {
            this.root = root; this.options = options; this.epoch = 0; this.busy = false;
            root.innerHTML = '<summary><i class="fa-solid fa-people-group" aria-hidden="true"></i><strong></strong><span class="sa-runs-count" role="status" aria-live="polite"></span><span class="sa-runs-keep" hidden><i class="sa-runs-keep-dot" aria-hidden="true"></i><span></span></span><i class="fa-solid fa-chevron-up sa-runs-chevron" aria-hidden="true"></i></summary><div class="sa-runs-body"><div class="sa-runs-list"></div><div class="sa-runs-footer"></div></div>';
            this.list = root.querySelector('.sa-runs-list');
            this.footer = root.querySelector('.sa-runs-footer');
            this.dialog = el('dialog', 'pi-native-dialog sa-runs-dialog');
            document.body.append(this.dialog);
            this.dialog.addEventListener('close', () => { this.dialog.replaceChildren(); this.returnFocus?.focus?.(); this.returnFocus = null; });
            root.addEventListener('toggle', () => { if (root.open) this.render(); });
            this.clock = setInterval(() => { if (!root.hidden && root.open && this.hasActive()) this.renderTimes(); }, 1000);
            this.reset();
        }
        reset() {
            this.epoch++; this.value = null; this.snapshot = null; this.background = null; this.busy = false;
            this.root.hidden = true; this.root.open = false; delete this.root.dataset.wasOpen; this.list.replaceChildren(); this.footer.replaceChildren();
            if (this.dialog.open) this.dialog.close();
        }
        hasActive() { return Boolean(this.snapshot?.runs.some(run => ACTIVE.has(run.state))); }
        apply(value) {
            if (!value || typeof value !== 'object') return;
            const signature = JSON.stringify(value);
            if (signature === this.value) return;
            this.value = signature; this.snapshot = value.snapshot || null; this.background = value.background || null;
            this.render();
        }
        render() {
            const runs = this.snapshot?.runs || [];
            const keep = Boolean(this.background?.active);
            this.root.hidden = !runs.length && !keep;
            if (this.root.hidden) return;
            const active = runs.filter(run => ACTIVE.has(run.state)).length;
            const attention = runs.filter(run => STATES[run.state]?.[2] === 'attention' || STATES[run.state]?.[2] === 'error').length;
            this.root.dataset.state = attention ? 'attention' : active ? 'active' : 'done';
            this.root.querySelector('summary strong').textContent = t('子 Agent');
            this.root.querySelector('.sa-runs-count').textContent = attention
                ? [active ? t('{0} 个运行中', active) : '', t('{0} 个需处理', attention)].filter(Boolean).join(' · ')
                : active ? t('{0} 个运行中', active) : runs.length ? t('{0} 个已结束', runs.length) : t('后台工作进行中');
            const keepBadge = this.root.querySelector('.sa-runs-keep');
            keepBadge.hidden = !keep; keepBadge.querySelector('span').textContent = t('会话保持中');
            keepBadge.title = t('后台子 Agent 未结束，Pivane 会保留此会话，以便结果返回后主 Agent 自动继续。');
            if (!this.root.open) return;
            this.list.replaceChildren(...runs.map(run => this.card(run)));
            if (!runs.length) this.list.append(el('p', 'sa-runs-empty', t('后台工作尚未提供运行详情。')));
            if (this.snapshot?.omitted?.runs) this.list.append(el('p', 'sa-runs-empty', t('另有 {0} 个运行未显示。', this.snapshot.omitted.runs)));
            this.footer.replaceChildren(
                this.button(t('刷新状态'), 'fa-solid fa-rotate', () => this.refresh()),
                this.button(t('用量与费用'), 'fa-solid fa-coins', () => this.showCost()));
            this.renderTimes();
        }
        card(run) {
            const [label, iconClass, tone] = STATES[run.state] || [run.state, 'fa-regular fa-circle', 'muted'];
            const card = el('article', 'sa-run'); card.dataset.tone = tone; card.dataset.runId = run.id;
            const head = el('div', 'sa-run-head');
            const status = el('span', 'sa-run-state'); status.append(icon(iconClass), el('span', '', t(label)));
            const title = el('strong', 'sa-run-title', run.label); title.title = run.label;
            head.append(status, title, el('span', 'sa-run-time'));
            card.append(head);
            const activity = run.activity || {};
            const meta = [
                run.kind === 'workflow' ? t('工作流') : null,
                activity.currentTool ? t('正在使用 {0}', activity.currentTool) : null,
                Number.isInteger(activity.turnCount) ? t('{0} 轮', activity.turnCount) : null,
                Number.isInteger(activity.toolCount) ? t('{0} 次工具', activity.toolCount) : null
            ].filter(Boolean);
            if (meta.length) card.append(el('p', 'sa-run-meta', meta.join(' · ')));
            if (run.children?.length) {
                const list = el('ul', 'sa-run-children');
                for (const child of run.children) list.append(this.child(child));
                card.append(list);
            }
            const actions = el('div', 'sa-run-actions');
            actions.append(this.button(t('查看模型'), 'fa-solid fa-microchip', () => this.showModels(run)));
            if (ACTIVE.has(run.state)) {
                actions.append(this.button(t('引导'), 'fa-regular fa-comment-dots', () => this.message(run, 'steer')));
                const stop = this.button(t('停止'), 'fa-regular fa-circle-stop', () => this.stop(run)); stop.classList.add('danger');
                actions.append(stop);
            } else if (RESUMABLE.has(run.state)) actions.append(this.button(t('继续'), 'fa-solid fa-play', () => this.message(run, 'resume')));
            card.append(actions);
            return card;
        }
        child(node, depth = 0) {
            const [label, iconClass, tone] = STATES[node.state] || [node.state, 'fa-regular fa-circle', 'muted'];
            const row = el('li'); row.dataset.tone = tone;
            const name = el('span', 'sa-child-label', node.label); name.title = node.label;
            row.append(icon(iconClass), name, el('span', 'sa-child-state', t(label)));
            if (node.activity?.currentTool && ACTIVE.has(node.state)) row.append(el('span', 'sa-child-tool', node.activity.currentTool));
            if (depth < 2 && node.children?.length) {
                const list = el('ul', 'sa-run-children');
                for (const child of node.children) list.append(this.child(child, depth + 1));
                row.append(list);
            }
            return row;
        }
        renderTimes() {
            const now = Date.now();
            for (const card of this.list.querySelectorAll('.sa-run')) {
                const run = this.snapshot?.runs.find(item => item.id === card.dataset.runId);
                const target = card.querySelector('.sa-run-time');
                if (!run || !target || !run.startedAt) continue;
                const end = ACTIVE.has(run.state) ? now : run.endedAt || run.updatedAt || now;
                target.textContent = duration(end - run.startedAt);
            }
        }
        button(text, iconClass, handler) {
            const button = el('button', 'sa-run-button'); button.type = 'button';
            button.append(icon(iconClass), el('span', '', text));
            button.disabled = this.busy || !this.options.connected();
            button.addEventListener('click', async () => {
                if (this.busy) return;
                const epoch = this.epoch; this.busy = true;
                this.root.querySelectorAll('.sa-run-button').forEach(item => { item.disabled = true; });
                try { await handler(button); }
                catch (error) { if (epoch === this.epoch) this.options.toast(error.message || t('子 Agent 操作失败'), 'error'); }
                finally { if (epoch === this.epoch) { this.busy = false; this.render(); } }
            });
            return button;
        }
        async request(method, params, timeoutMs = 60000) {
            const epoch = this.epoch;
            const data = await this.options.request(method, params, timeoutMs);
            if (epoch !== this.epoch) throw Object.assign(new Error(t('会话已切换')), { stale: true });
            return data;
        }
        async refresh() {
            const data = await this.request('status', {});
            if (data?.snapshot) { this.snapshot = data.snapshot; this.value = null; }
            this.options.toast(t('已刷新子 Agent 状态'), 'success');
        }
        openDialog(title, content, actions = []) {
            this.returnFocus = document.activeElement;
            const heading = el('div', 'pi-native-heading'); heading.append(el('strong', '', title));
            const close = el('button', '', t('关闭')); close.type = 'button'; close.addEventListener('click', () => this.dialog.close());
            heading.append(close);
            const body = el('div', 'pi-native-body sa-runs-dialog-body'); body.append(...content);
            const footer = el('div', 'sa-runs-dialog-actions'); footer.append(...actions);
            this.dialog.replaceChildren(heading, body, footer);
            this.dialog.showModal();
        }
        async showModels(run) {
            const models = stepModels((await this.request('status', { id: run.id }))?.text);
            const thinking = { off: '关闭思考', minimal: '极低', low: '低', medium: '中等', high: '高', xhigh: '很高', max: '最高' };
            const list = el('ul', 'sa-models');
            for (const step of models) {
                const item = el('li', 'sa-model');
                const [stateLabel, iconClass, tone] = STATES[step.state === 'completed' ? 'complete' : step.state] || [step.state, 'fa-regular fa-circle', 'muted'];
                const role = step.agent ? window.PiSubagentSettings?.roleName?.(step.agent) || step.agent : null;
                const head = el('div', 'sa-model-head');
                const icon = el('i', iconClass); icon.setAttribute('aria-hidden', 'true');
                const state = el('span', 'sa-model-state'); state.dataset.tone = tone; state.title = t(stateLabel); state.append(icon);
                head.append(state, el('strong', 'sa-model-name', step.name || step.step), el('span', 'sa-model-step', role ? `${role} · ${step.step}` : step.step));
                const tags = el('div', 'sa-model-tags');
                const model = el('code', 'sa-model-id', step.model || t('默认模型')); model.title = step.model || t('pi-subagents 未报告模型，使用继承的默认模型');
                if (!step.model) model.classList.add('muted');
                tags.append(model);
                if (step.thinking) tags.append(el('span', 'sa-model-thinking', t('思考 {0}', t(thinking[step.thinking] || step.thinking))));
                item.append(head, tags); list.append(item);
            }
            const content = models.length ? [list] : [el('p', 'pi-native-help', t('pi-subagents 没有报告此运行的模型信息。'))];
            this.openDialog(t('模型 · {0}', run.label), content);
        }
        async stop(run) {
            if (!window.confirm(t('停止“{0}”？已完成的步骤会保留，进行中的工作会被中断。', run.label))) return;
            const data = await this.request('stop', { id: run.id });
            this.options.toast(data?.state === 'stopping' ? t('已请求停止，状态更新后会显示在这里') : t('已发送停止请求'), 'success');
        }
        message(run, method) {
            const steer = method === 'steer';
            const label = el('label', 'sa-runs-field');
            label.append(el('span', '', steer ? t('要告诉子 Agent 的内容') : t('继续时的说明')));
            const input = el('textarea'); input.rows = 4; input.maxLength = 8000; input.required = true;
            input.placeholder = steer ? t('例如：优先检查登录流程，不需要修改测试') : t('例如：根据刚才的结果继续完成剩余部分');
            label.append(input);
            const content = [label];
            let mode;
            if (steer) {
                const field = el('label', 'sa-runs-field'); field.append(el('span', '', t('送达时机')));
                mode = el('select');
                mode.append(new Option(t('尽快送达（当前工具执行后）'), 'steer'), new Option(t('当前任务完成后再处理'), 'follow_up'));
                field.append(mode); content.push(field);
            } else content.push(el('p', 'pi-native-help', t('继续会在原运行的基础上新开一轮，使用它原来的模型和权限。')));
            const submit = el('button', 'primary', steer ? t('发送引导') : t('继续运行')); submit.type = 'button';
            submit.addEventListener('click', async () => {
                const text = input.value.trim();
                if (!text) { input.focus(); return; }
                const epoch = this.epoch;
                submit.disabled = true; input.disabled = true;
                try {
                    const data = await this.request(method, steer ? { id: run.id, message: text, mode: mode.value } : { id: run.id, message: text });
                    if (data?.isError) throw new Error(data.text || t('子 Agent 操作失败'));
                    this.dialog.close();
                    this.options.toast(steer ? t('引导已送达子 Agent') : t('已请求继续运行'), 'success');
                } catch (error) {
                    if (epoch === this.epoch) { submit.disabled = false; input.disabled = false; this.options.toast(error.message, 'error'); }
                }
            });
            this.openDialog(steer ? t('引导 · {0}', run.label) : t('继续 · {0}', run.label), content, [submit]);
            input.focus();
        }
        async showCost() {
            const { cost } = await this.request('cost', {});
            if (!cost) throw new Error(t('当前 pi-subagents 版本不提供用量数据'));
            const table = el('table', 'sa-runs-cost');
            const head = el('tr'); for (const text of [t('来源'), t('输入'), t('输出'), t('费用')]) head.append(el('th', '', text));
            table.append(head);
            const row = (name, usage, className) => {
                const tr = el('tr', className);
                tr.append(el('td', '', name), el('td', '', tokens(usage?.input)), el('td', '', tokens(usage?.output)), el('td', '', money(usage?.cost)));
                table.append(tr);
            };
            row(t('主 Agent'), cost.parent);
            for (const child of cost.children) row(child.agent ? `${child.label} · ${child.agent}` : child.label, child.usage);
            row(t('子 Agent 合计'), cost.childTotal, 'sum');
            row(t('总计'), cost.total, 'sum');
            const content = [el('p', 'pi-native-help', t('统计当前会话分支中主 Agent 与子 Agent 报告的用量；费用按模型价格估算。'))];
            if (cost.unresolvedAsyncChildren) content.push(el('p', 'pi-native-help warning', t('另有 {0} 个后台子 Agent 的用量未能读取，合计可能偏低。', cost.unresolvedAsyncChildren)));
            const wrap = el('div', 'sa-runs-cost-wrap'); wrap.append(table); content.push(wrap);
            this.openDialog(t('子 Agent 用量与费用'), content);
        }
    }
    PiSubagentRuns.stepModels = stepModels;
    window.PiSubagentRuns = PiSubagentRuns;
})();
