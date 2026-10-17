/* Background-learning settings and jobs. The server owns learning, model routing and quota. */
(() => {
    'use strict';
    const U = globalThis.PiIdentityUI;
    const { el, t } = U;
    const copy = {
        enabled: ['后台学习', '对话之后，用辅助模型把你的纠正、偏好和可复用做法整理成记忆或技能草稿。', '开启后，助手会在对话之后用辅助模型回顾聊天，把你的纠正、偏好和值得复用的做法整理成记忆或技能草稿。它不会修改对话内容；新技能只作为草稿，需要你审核后才会启用。'],
        correctionEnabled: ['纠错识别', '你纠正助手或说“以后都这样”时，立即记下来。', '识别“不对，应该是……”“以后都用……”这类明确的纠正和长期偏好，并优先处理。可以在高级设置里补充你习惯的说法。使用“纠错模型”。'],
        reviewEnabled: ['对话复盘', '回顾普通对话，提炼值得长期记住的内容。', '没有明确纠正的对话会交给复盘：判断其中是否有新的事实、偏好或可复用的做法，并与已有记忆比较后决定跳过、补充还是新建。复盘频率为“每轮对话后”时，每轮对话都会占用一次运行次数；按间隔复盘可以明显节省次数。使用“复盘模型”。'],
        extractionEnabled: ['候选提取', '对话压缩或结束时，补充提取还没学到的内容。', '线程压缩上下文或结束时，检查还没有被学习过的对话片段，补充提取值得记住的内容，避免信息随压缩丢失。使用“提炼模型”。'],
    };
    const budgetInfo = '每次运行最多预留 6,000 tokens（整理合并按读取字数另加），实际消耗通常更少。“运行次数”和“预留 tokens”任意一项用完，当天的后台学习就会暂停，到重置时间后恢复。手动“立即复盘”也计入。';
    // Every learning option carries an (i) explanation; these cover the fields without a switch row.
    const fieldInfo = {
        frequency: '“每轮对话后”在每轮对话结束时复盘，最及时，但每轮都会占用一次运行次数。按间隔复盘会把这段时间的对话合并成一次，预算有限或对话频繁时更省。',
        maxRunsPerDay: '纠错识别、对话复盘、候选提取和整理合并每执行一次都算一次运行，手动“立即复盘”也计入。达到上限后当天暂停，到重置时间恢复。',
        maxTokensPerDay: '每次运行开始前最多预留 6,000 tokens（整理合并另加读取字数），防止意外超支；实际消耗通常更少，以供应商报告为准。剩余额度不足一次预留时，当天暂停。',
        consolidationInputChars: '整理合并时一次最多读取多少字的记忆交给模型比较。读得越多，越能发现分散的重复内容，但每次预留的 tokens 也越多（读取字数 + 6,000）。',
        correction: '消息包含这些短语时，会被当作纠正并立即交给纠错模型学习，例如“下次记得”。',
        preference: '消息包含这些短语时，会被当作长期偏好并立即学习，例如“我一般习惯”。',
        temporary: '包含这些短语的要求只对当前对话有效，不会被学习，例如“仅本次”。',
        ignore: '命中这些短语时，即使同时命中上面的规则，也不算纠正或偏好，可用来排除误判。',
    };
    const purposes = { 'memory-correction': '纠错模型', 'memory-review': '复盘模型', 'memory-extraction': '提炼模型' };
    const healthLabels = { ok: '正常', off: '已关闭', unavailable: '不可用', 'needs-model': '缺少模型', 'memory-full': '记忆已满', 'quota-exhausted': '额度用完', failing: '连续失败' };
    const jobLabels = { correction: '纠错识别', review: '对话复盘', extraction: '候选提取', manual: '手动复盘', consolidate: '整理合并', queued: '排队中', running: '运行中', completed: '已完成', failed: '失败', uncertain: '待核对', conflict: '版本冲突', skipped: '已跳过', cancelled: '已取消', cancelling: '取消中', pending: '等待中', 'waiting-config': '等待模型配置' };
    const errorLabels = { 'memory-full': '记忆已满，未保存', 'content-blocked': '内容疑似密钥或注入指令，未保存', 'model-unavailable': '模型不可用', interrupted: '运行已中断', 'source-changed': '来源已变化', 'configuration-changed': '设置已变化', duplicate: '已有相同内容', 'no-consolidation': '无需整理合并', 'nothing-to-consolidate': '没有可合并的条目', 'invalid-proposal': '模型建议未通过校验', 'learning-failed': '学习失败' };
    const frequencies = [[0, '每轮对话后'], [30, '每 30 分钟'], [60, '每小时'], [180, '每 3 小时'], [1440, '每天']];
    const presets = [['save', '节省', 'leaf', 8, 80000], ['balanced', '均衡', 'scale-balanced', 20, 200000], ['active', '积极', 'bolt', 80, 800000]];
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const clone = value => JSON.parse(JSON.stringify(value));
    const validSnapshot = data => data?.version === 1 && Number.isSafeInteger(data.revision) && data.settings;
    const rejected = error => error.status >= 400 && error.status < 500;

    function create({ apiFetch, root, ui }) {
        const states = new Map();
        let profileId = null, active = false, pending = false, epoch = 0, catalog = null, catalogPending = false;
        let form, savebar;
        const state = () => states.get(profileId);
        const changes = s => Object.fromEntries(Object.keys(s?.draft || {}).filter(key => Object.hasOwn(s.base || {}, key) && !same(s.draft[key], s.base[key])).map(key => [key, s.draft[key]]));
        const dirty = () => Object.keys(changes(state())).length > 0;
        const path = id => `/api/pi/profiles/${encodeURIComponent(id)}/learning`;
        const can = name => state()?.snapshot?.capabilities?.actions?.includes(name);
        const writable = () => !pending && state()?.snapshot?.capabilities?.settingsWrite !== false && !state()?.saveUncertain;
        const actionDisabled = () => pending || Boolean(state()?.uncertain);
        function syncSavebar() {
            savebar?.set({ dirty: dirty(), saving: pending, canSave: writable() });
            // Keep the hidden bar out of the scrolling pane's geometry on narrow screens.
            if (savebar) savebar.element.hidden = !dirty() && !pending;
        }
        function receive(s, data) {
            const patch = changes(s);
            s.snapshot = data; s.base = clone(data.settings); s.draft = { ...clone(data.settings), ...patch };
        }
        async function refresh() {
            if (!active || !profileId || pending) return;
            const id = profileId, generation = ++epoch, s = state();
            try {
                const data = await apiFetch(path(id));
                if (!active || id !== profileId || generation !== epoch) return;
                if (!validSnapshot(data)) throw new Error(t('学习接口不兼容'));
                receive(s, data); s.error = null; s.saveUncertain = false;
            } catch (error) {
                if (!active || id !== profileId || generation !== epoch) return;
                s.error = t('读取失败：{0}', error.message);
            }
            render();
        }
        async function open(id) {
            if (pending) return;
            profileId = id; active = true;
            if (!states.has(id)) states.set(id, { snapshot: null, base: {}, draft: {}, notice: null, uncertain: null, customBudget: false, customFrequency: false, advanced: false });
            render(); await refresh();
        }
        function close() { if (pending) return; active = false; ++epoch; root.replaceChildren(); }
        function discardChanges() {
            const s = state(); if (!s || pending) return;
            s.draft = clone(s.base); s.customBudget = s.customFrequency = false;
            if (active) render();
        }
        function notice(text, actions = [], tone = 'amber', className = '') {
            return el('div', { class: `pi-id-notice ${className}`.trim(), dataset: { tone }, role: 'status' }, [U.icon('circle-info'), el('div', { class: 'pi-id-notice-body' }, [el('p', { text }), actions.length && el('div', { class: 'pi-id-notice-actions' }, actions)])]);
        }
        function button(label, onClick, options = {}) { return U.button({ label: t(label), onClick, ...options }); }
        function field(label, input, help, infoKey) {
            const id = input.id || U.uid('pi-learning-field'); input.id = id;
            const tip = fieldInfo[infoKey] ? U.info({ label: t(label), body: t(fieldInfo[infoKey]) }) : null;
            const name = el('label', { for: id, text: t(label) });
            return el('div', { class: 'pi-id-field' }, [tip ? el('div', { class: 'pi-id-field-label' }, [name, tip.button]) : name, tip?.panel, input, help && el('small', { text: help })]);
        }
        function numberField(key, label, defaults = {}) {
            const s = state(), limits = { ...(s.snapshot.capabilities?.limits?.[key] || defaults) };
            if (key === 'periodicReviewMinutes') limits.min = Math.max(1, limits.min || 0);
            const input = el('input', { class: 'pi-id-input', type: 'number', name: key, value: s.draft[key], min: limits.min, max: limits.max, step: 1, required: true, disabled: !writable(), on: { input: event => { s.draft[key] = event.target.value === '' ? null : Number(event.target.value); syncSavebar(); } } });
            return field(label, input, limits.min !== undefined && limits.max !== undefined ? t('范围：{0}–{1}', U.number(limits.min), U.number(limits.max)) : null, key);
        }
        function switchRow(key) {
            const s = state(), [label, description, info] = copy[key];
            return U.switchRow({ label: t(label), description: t(description), info: t(info), name: key, checked: s.draft[key] === true, disabled: !writable(), onChange: checked => { s.draft[key] = checked; render(); } }).row;
        }
        async function save() {
            const s = state();
            if (!dirty() || !writable() || !form?.reportValidity()) return;
            const patch = clone(changes(s)), id = profileId;
            pending = true; ++epoch; s.notice = null; render();
            try {
                const data = await apiFetch(path(id), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: s.snapshot.revision, changes: patch }) });
                if (!validSnapshot(data)) throw new Error(t('保存回执未确认'));
                s.snapshot = data; s.base = clone(data.settings); s.draft = clone(data.settings);
                ui.toast(t('学习设置已保存，不会立即运行作业'), { tone: 'success' });
            } catch (error) {
                s.notice = error.status === 409 ? t('学习设置版本冲突；草稿已保留，请刷新核对。')
                    : rejected(error) ? t('学习设置被拒绝：{0}，草稿已保留。', error.message) : t('学习设置未确认：{0}。草稿已保留，请刷新核对。', error.message);
                s.saveUncertain = !rejected(error);
            } finally { pending = false; if (active && profileId === id) render(); }
        }
        async function action(name, extra = {}) {
            const s = state();
            if (actionDisabled() || !can(name)) return;
            const id = profileId, requestId = globalThis.crypto?.randomUUID?.() || `learning-${Date.now()}-${Math.random().toString(16).slice(2)}`;
            pending = true; ++epoch; s.notice = null; render();
            try {
                const data = await apiFetch(`${path(id)}/actions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, action: name, ...extra }) });
                if (!validSnapshot(data)) throw new Error(t('作业回执未确认'));
                receive(s, data);
                ui.toast(t('请求已处理，请以运行记录和学习状态为准。'), { tone: 'success' });
            } catch (error) {
                s.notice = error.status === 409 ? t('作业请求冲突；请刷新核对。') : rejected(error) ? t('作业请求被拒绝：{0}', error.message) : t('作业结果未确认：{0}。刷新核对，不自动重试。', error.message);
                if (!rejected(error)) s.uncertain = { requestId, action: name, ...extra };
            } finally { pending = false; if (active && profileId === id) render(); }
        }
        async function loadCatalog() {
            if (catalog || catalogPending) return;
            catalogPending = true;
            try { const data = await apiFetch('/api/pi/settings/models'); catalog = { models: data.models || [], providers: data.providers || [] }; }
            catch { catalog = { models: [], providers: [] }; }
            finally { catalogPending = false; if (active) render(); }
        }
        function legacyBanner() {
            const s = state(), legacy = s.snapshot.legacy;
            if (!legacy) return null;
            const body = el('div', { class: 'pi-id-notice-body' }, [el('p', { text: t('此身份开启过旧版自动学习，新版需要确认后才会继续学习。') }),
                el('p', { class: 'pi-id-help', text: t('将设置的用途：{0}', (legacy.purposes || []).map(key => t(purposes[key] || key)).join('、') || t('无')) }),
                el('p', { class: 'pi-id-help', text: t('模型：{0}', legacy.reviewModel?.provider ? `${legacy.reviewModel.provider}/${legacy.reviewModel.modelId}` : t('未提供')) })]);
            let chosen = null;
            if (legacy.reviewModelAvailable === false) {
                body.append(el('p', { text: t('旧模型不可用，请选择新的辅助模型。') }));
                const models = (catalog?.models || []).filter(model => model.available && model.input?.includes('text') && !/:batch$/.test(model.id));
                const provider = el('select', { class: 'pi-id-select', 'aria-label': t('供应商'), disabled: actionDisabled() });
                const model = el('select', { class: 'pi-id-select', 'aria-label': t('模型'), disabled: actionDisabled() });
                for (const id of new Set(models.map(row => row.provider))) provider.append(el('option', { value: id, text: catalog.providers.find(row => row.id === id)?.name || id }));
                provider.value = models.some(row => row.provider === s.legacyModel?.provider) ? s.legacyModel.provider : provider.options[0]?.value || '';
                const fill = () => {
                    model.replaceChildren(...models.filter(row => row.provider === provider.value).map(row => el('option', { value: row.id, text: row.name || row.id })));
                    model.value = [...model.options].some(row => row.value === s.legacyModel?.modelId) ? s.legacyModel.modelId : model.options[0]?.value || '';
                    chosen = provider.value && model.value ? { provider: provider.value, modelId: model.value } : null; s.legacyModel = chosen;
                };
                fill(); provider.onchange = () => { fill(); render(); }; model.onchange = () => { chosen = { provider: provider.value, modelId: model.value }; s.legacyModel = chosen; };
                body.append(el('div', { class: 'pi-learning-fields' }, [field('供应商', provider), field('模型', model)]));
                if (!models.length) body.append(el('p', { class: 'pi-id-help', text: t('暂无可用文本模型，请先配置辅助模型。') }));
                if (!catalog) void loadCatalog();
            }
            body.append(el('div', { class: 'pi-id-notice-actions' }, [button('迁移并开启', () => void action('adopt-legacy', chosen ? { model: chosen } : {}), { variant: 'primary', disabled: actionDisabled() || !can('adopt-legacy') || legacy.reviewModelAvailable === false && !chosen }),
                button('不再提示', () => void action('dismiss-legacy'), { variant: 'ghost', disabled: actionDisabled() || !can('dismiss-legacy') })]));
            return el('div', { class: 'pi-id-notice pi-learning-legacy', dataset: { tone: 'amber' } }, [U.icon('clock-rotate-left'), body]);
        }
        function todayCard() {
            const data = state().snapshot, today = data.health?.today || {}, jobs = [...(data.jobs || []), ...(data.recentRuns || [])];
            const runs = today.runs || 0, maxRuns = today.maxRuns ?? data.settings.maxRunsPerDay;
            const tokens = today.reservedTokens || 0, maxTokens = today.maxTokens ?? data.settings.maxTokensPerDay;
            const exhausted = Object.hasOwn(today, 'exhaustedBy') ? today.exhaustedBy : runs >= maxRuns ? 'runs' : tokens + (data.capabilities?.reservedTokensPerRun || 6000) > maxTokens ? 'tokens' : null;
            // The server aggregate is authoritative, including an explicit null; older servers fall back to counted runs only.
            const reported = jobs.filter(job => !job.quotaRefund && job.startedAt?.startsWith(new Date().toISOString().slice(0, 10)) && Number.isFinite(job.usage?.totalTokens));
            const used = Object.hasOwn(today, 'usedTokens') ? (Number.isFinite(today.usedTokens) ? today.usedTokens : null) : reported.length ? reported.reduce((sum, job) => sum + job.usage.totalTokens, 0) : null;
            const reset = today.resetsAt ? new Date(today.resetsAt) : new Date(new Date().setUTCHours(24, 0, 0, 0));
            const info = U.info({ label: t('今日用量'), body: t(budgetInfo) });
            return U.card({ title: t('今日用量'), icon: 'gauge-high', actions: [info.button], className: 'pi-learning-usage' }, [el('div', { class: 'pi-learning-stack' }, [
                U.meter({ label: t('运行次数'), value: runs, max: maxRuns, level: exhausted === 'runs' ? 'full' : undefined, valueText: `${U.number(runs)} / ${U.number(maxRuns)}${exhausted === 'runs' ? ` · ${t('已达上限')}` : ''}` }),
                U.meter({ label: t('预留 tokens'), value: tokens, max: maxTokens, level: exhausted === 'tokens' ? 'full' : undefined, valueText: `${U.compact(tokens)} / ${U.compact(maxTokens)}${exhausted === 'tokens' ? ` · ${t('剩余不足一次运行')}` : ''}` }),
                el('small', { class: 'pi-id-help', text: used === null ? t('供应商报告的实际用量：暂无报告') : t('供应商报告的实际用量：约 {0} tokens（今天）', U.compact(used)) }),
                el('small', { class: 'pi-id-help', text: t('每天 {0} 重置', reset.toLocaleTimeString(U.locale(), { hour: '2-digit', minute: '2-digit', hour12: false })) })]), info.panel]);
        }
        function modesCard() {
            const s = state(), children = [];
            for (const key of ['correctionEnabled', 'reviewEnabled', 'extractionEnabled']) {
                if (!Object.hasOwn(s.draft, key)) continue;
                children.push(switchRow(key));
                if (key === 'reviewEnabled' && s.draft.reviewEnabled) {
                    const custom = s.customFrequency || !frequencies.some(([value]) => value === s.draft.periodicReviewMinutes);
                    const select = el('select', { class: 'pi-id-select', name: 'frequency', disabled: !writable(), on: { change: event => {
                        s.customFrequency = event.target.value === 'custom';
                        s.draft.periodicReviewMinutes = s.customFrequency ? Math.max(1, s.draft.periodicReviewMinutes || 30) : Number(event.target.value); render();
                    } } }, [...frequencies.map(([value, label]) => el('option', { value, text: t(label) })), el('option', { value: 'custom', text: t('自定义…') })]);
                    select.value = custom ? 'custom' : String(s.draft.periodicReviewMinutes);
                    const frequency = el('div', { class: 'pi-learning-frequency pi-learning-fields' }, [field('复盘频率', select, null, 'frequency')]);
                    if (custom) frequency.append(numberField('periodicReviewMinutes', '间隔（分钟）', { min: 1, max: 10080 }));
                    children.push(frequency);
                }
            }
            return U.card({ title: t('学习方式'), icon: 'seedling' }, children);
        }
        function budgetCard() {
            const s = state(), limits = s.snapshot.capabilities?.limits || {};
            const clamp = (value, key) => Math.max(limits[key]?.min ?? 0, Math.min(value, limits[key]?.max ?? value));
            const matched = presets.find(([, , , runs, tokens]) => runs === s.draft.maxRunsPerDay && tokens === s.draft.maxTokensPerDay);
            const selected = s.customBudget || !matched ? 'custom' : matched[0];
            const choices = el('div', { class: 'pi-id-choices', role: 'radiogroup', 'aria-label': t('每日预算') });
            for (const [id, label, icon, runs, tokens] of [...presets, ['custom', '自定义', 'sliders']]) {
                const valid = id === 'custom' || clamp(runs, 'maxRunsPerDay') === runs && clamp(tokens, 'maxTokensPerDay') === tokens;
                choices.append(el('label', { class: 'pi-id-choice', title: valid ? undefined : t('当前服务器不支持此预算') }, [
                    el('input', { type: 'radio', name: 'budget', value: id, checked: selected === id, disabled: !writable() || !valid, on: { change: () => {
                        s.customBudget = id === 'custom'; if (!s.customBudget) { s.draft.maxRunsPerDay = clamp(runs, 'maxRunsPerDay'); s.draft.maxTokensPerDay = clamp(tokens, 'maxTokensPerDay'); } render();
                    } } }), el('span', { class: 'pi-id-choice-title' }, [U.icon(icon), t(label)]), el('small', { text: id === 'custom' ? t('自己设定上限') : t('每天 {0} 次 · {1} tokens', U.number(runs), U.compact(tokens)) })]));
            }
            const info = U.info({ label: t('每日预算'), body: t(budgetInfo) });
            return U.card({ title: t('每日预算'), icon: 'wallet', actions: [info.button] }, [choices, selected === 'custom' && el('div', { class: 'pi-learning-fields pi-learning-custom' }, [numberField('maxRunsPerDay', '每天最多运行次数'), numberField('maxTokensPerDay', '每天最多预留 tokens')]), info.panel]);
        }
        function advancedCard() {
            const s = state(), limits = s.snapshot.capabilities?.limits?.triggerPhrases || {};
            const body = el('div', { class: 'pi-learning-stack pi-learning-advanced-body' }, [numberField('consolidationInputChars', '整理合并单次读取字数', { min: 4000, max: 40000 }),
                el('p', { class: 'pi-id-help', text: t('整理合并预留 tokens = 读取字数 + 6,000。') }), el('strong', { text: t('自定义触发词') }),
                el('p', { class: 'pi-id-help', text: t('内置规则已识别常见的中文和英文说法。这里可补充你的习惯用语或其他语言，每行一个短语，不区分大小写。') })]);
            const triggers = el('div', { class: 'pi-learning-triggers' }); body.append(triggers);
            for (const [key, label] of [['correction', '表示纠正（立即学习）'], ['preference', '表示长期偏好（立即学习）'], ['temporary', '表示临时要求（不学习）'], ['ignore', '排除（即使命中上面也不算纠正或偏好）']]) {
                const area = el('textarea', { class: 'pi-id-textarea', name: `trigger-${key}`, rows: 3, value: (s.draft.triggerPhrases?.[key] || []).join('\n'), disabled: !writable() });
                area.oninput = () => {
                    const lines = area.value.split('\n').map(line => line.trim()).filter(Boolean);
                    const invalid = lines.length > (limits.maxPhrases || 50) || lines.some(line => line.length > (limits.maxLength || 80) || /[\u0000-\u001f\u007f]/.test(line));
                    area.setCustomValidity(invalid ? t('最多 {0} 个短语，每个不超过 {1} 个字符，不能包含控制字符。', limits.maxPhrases || 50, limits.maxLength || 80) : '');
                    area.setAttribute('aria-invalid', String(invalid)); s.draft.triggerPhrases = { ...s.draft.triggerPhrases, [key]: lines }; syncSavebar();
                };
                // Revalidate retained drafts too, including after a tab switch.
                area.oninput(); triggers.append(field(label, area, null, key));
            }
            return el('details', { class: 'pi-id-card pi-learning-advanced', open: s.advanced, on: { toggle: event => { s.advanced = event.target.open; } } }, [el('summary', { text: t('高级设置') }), body]);
        }
        function historyCard() {
            const s = state(), data = s.snapshot;
            const jobs = [...new Map([...(data.jobs || []), ...(data.recentRuns || [])].map((job, i) => [job.id || i, job])).values()]
                .sort((a, b) => Date.parse(b.createdAt || b.startedAt || 0) - Date.parse(a.createdAt || a.startedAt || 0)).slice(0, 20);
            const list = el('ol', { class: 'pi-id-timeline' });
            for (const job of jobs) {
                const tone = job.status === 'completed' ? 'green' : ['failed', 'conflict'].includes(job.status) ? 'danger' : ['uncertain', 'waiting-config'].includes(job.status) ? 'amber' : 'neutral';
                const model = job.model?.provider ? `${job.model.provider}/${job.model.modelId || job.model.id || ''}` : t('模型未分配');
                const technical = el('details', { class: 'pi-id-details' }, [el('summary', { text: t('技术详情') }), el('dl', {}, [el('dt', { text: t('作业 ID') }), el('dd', { text: job.id || '—' }), el('dt', { text: t('请求 ID') }), el('dd', { text: job.requestId || '—' }), el('dt', { text: t('关联回执') }), el('dd', { text: (job.receiptIds || []).join(', ') || '—' }), job.error && el('dt', { text: t('错误详情') }), job.error && el('dd', { text: job.error })])]);
                list.append(el('li', {}, [el('span', { class: 'pi-id-timeline-icon', dataset: { tone } }, [U.icon(job.status === 'completed' ? 'check' : 'clock')]),
                    el('div', { class: 'pi-id-timeline-copy' }, [el('div', { class: 'pi-learning-job-title' }, [el('strong', { text: t(jobLabels[job.reason] || '后台学习') }), U.chip(t(jobLabels[job.status] || '状态未知'), tone)]),
                        el('small', {}, [U.time(job.endedAt || job.startedAt || job.createdAt)]), el('small', { text: [model, Number.isFinite(job.usage?.totalTokens) ? t('{0} tokens', U.number(job.usage.totalTokens)) : t('用量暂无报告'),
                            job.costStatus === 'reported' && Number.isFinite(job.usage?.reportedCostUsd) ? t('供应商报告费用：${0}', job.usage.reportedCostUsd) : t('费用未知')].join(' · ') }),
                        job.error && el('p', { class: 'pi-id-help', text: t(errorLabels[job.error] || '运行未完成，请查看技术详情。') }), technical]),
                    can('cancel') && job.id && ['queued', 'running', 'pending', 'waiting-config'].includes(job.status) && button('取消作业', () => void action('cancel', { jobId: job.id }), { variant: 'ghost', disabled: actionDisabled() })]));
            }
            return U.card({ title: t('运行记录'), icon: 'clock-rotate-left', actions: [button('刷新', () => void refresh(), { icon: 'rotate', iconOnly: true, variant: 'ghost', disabled: pending })] }, [jobs.length ? list : U.empty({ icon: 'clock', title: t('还没有运行记录'), text: t('开始对话后，符合条件的学习会出现在这里。'), compact: true })]);
        }
        function render() {
            if (!active) return;
            const expanded = new Set([...root.querySelectorAll('.pi-id-info[aria-expanded=true]')].map(node => node.getAttribute('aria-label')));
            const s = state(); root.replaceChildren();
            if (!s.snapshot) { root.append(notice(s.error || t('正在读取学习设置…'), s.error ? [button('重新读取', () => void refresh())] : [], s.error ? 'danger' : 'neutral')); return; }
            const legacy = legacyBanner(); if (legacy) root.append(legacy);
            if (s.notice || s.error) root.append(notice(s.notice || s.error, [button('刷新并核对', () => void refresh(), { variant: 'quiet', disabled: pending })]));
            if (s.uncertain) root.append(notice(t('作业请求 {0} 结果未确认；请先核对作业列表，勿重复提交。', s.uncertain.requestId), [button('已核对作业列表', () => { s.uncertain = null; s.notice = null; render(); }, { variant: 'quiet', disabled: pending })], 'amber', 'pi-learning-uncertain'));
            const data = s.snapshot, health = data.health?.state || (data.settings.enabled ? 'unavailable' : 'off');
            const hero = U.card({ className: 'pi-learning-hero' }, [switchRow('enabled'), el('div', { class: 'pi-learning-hero-footer' }, [U.chip(t(healthLabels[health] || '不可用'), health === 'ok' ? 'green' : health === 'off' ? 'neutral' : 'amber', { icon: health === 'ok' ? 'circle-check' : 'circle-info' }),
                el('div', { class: 'pi-id-toolbar' }, [!data.settings.enabled && can('enable') && button('一键开启（推荐设置）', () => void action('enable'), { icon: 'seedling', variant: 'primary', disabled: actionDisabled() }), can('review-now') && button('立即复盘', () => void action('review-now'), { icon: 'play', disabled: actionDisabled() })])])]);
            root.append(hero);
            if (data.status !== 'ready' || data.capabilities?.installed === false) root.append(notice(t('后台学习当前不可用，请检查身份和长期记忆设置。'), [button('前往设定', () => ui.navigate('persona'), { variant: 'quiet' })]));
            if (data.capabilities?.settingsWrite === false) root.append(notice(t('当前服务器不支持修改学习设置。')));
            const missing = data.health?.missingModels || [];
            if (missing.length) root.append(notice(t('还需要配置：{0}', missing.map(key => t(purposes[key] || key)).join(' / ')), [button('前往设置 → 辅助模型', () => ui.openSettings({ tab: 'models' }), { variant: 'quiet' })], 'amber', 'pi-learning-missing'));
            root.append(todayCard());
            form = el('form', { class: 'pi-learning-form', on: { submit: event => { event.preventDefault(); void save(); } } }, [modesCard(), budgetCard(), advancedCard()]);
            root.append(form, historyCard());
            savebar = U.createSaveBar({ saveLabel: t('保存学习设置'), onSave: () => void save(), onDiscard: async () => {
                if (await ui.confirm({ title: t('放弃未保存的修改？'), message: t('学习设置将恢复为上次读取的内容。'), accept: t('放弃修改') })) discardChanges();
            } });
            root.append(savebar.element); syncSavebar();
            for (const info of root.querySelectorAll('.pi-id-info')) if (expanded.has(info.getAttribute('aria-label'))) info.click();
        }
        root.addEventListener('keydown', event => {
            if (active && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); }
        });
        return { open, close, refresh, dirty, discardChanges, busy: () => pending };
    }
    globalThis.PiProfileLearning = Object.freeze({ create });
})();
