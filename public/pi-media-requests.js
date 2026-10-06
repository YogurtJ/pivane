// In-chat media cards. The Agent's validated plan (media_generate or
// media_plan_request tool result) becomes a card: the user reviews or edits the
// parameters and confirms there; the server reviews and executes one lab ticket.
// State lives in the server journal keyed by plan id, so refresh, another tab or
// the phone shows the same result instead of offering a duplicate submission.
(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const KEY = /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const TOOLS = new Set(['media_generate', 'media_plan_request']);
    const MEDIA_URL = /^\/(images|videos|audio)\/[^/?#\\]+(?:\?[^#]*)?$/;
    const TEXT_KEYS = ['prompt', 'text', 'input'];
    const ICONS = { image: 'fa-image', video: 'fa-film', tts: 'fa-volume-high' };
    const KIND_NAMES = { image: '图像', video: '视频', tts: '语音' };
    const el = (tag, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
    const icon = name => { const node = el('i', `fa-solid ${name}`); node.setAttribute('aria-hidden', 'true'); return node; };

    function planOf(message) {
        if (message?.role !== 'toolResult' || message.isError || !TOOLS.has(message.toolName)) return null;
        const plan = message.details?.plan;
        if (!plan || !KEY.test(plan.id || '') || typeof plan.modelId !== 'string' || !plan.parameters || typeof plan.parameters !== 'object' || Array.isArray(plan.parameters)) return null;
        return plan;
    }

    function create({ fetch }) {
        const memory = new Map();   // key -> { state, parameters, editing, error, notice, armed }
        const cards = new Map();    // key -> latest rendered card
        let catalog = null, queued = new Set(), queueTimer = null, poller = null;

        const models = () => catalog ||= fetch('/api/pi/media/lab').then(data => new Map((data?.models || []).map(model => [model.id, model])))
            .catch(error => { catalog = null; throw error; });
        const slot = key => { if (!memory.has(key)) memory.set(key, { state: null, parameters: null, editing: false, error: '', notice: '', armed: false, busy: false }); return memory.get(key); };
        const live = () => [...cards.values()].filter(card => card.root.isConnected);
        const running = key => memory.get(key)?.state?.attempts?.some(attempt => attempt.status === 'running');

        function request(keys) {
            for (const key of keys) queued.add(key);
            if (queueTimer) return;
            queueTimer = setTimeout(async () => {
                queueTimer = null;
                const batch = [...queued].slice(0, 100); queued = new Set([...queued].slice(100));
                if (queued.size) request([]);
                try {
                    const data = await fetch(`/api/pi/media/chat/requests?keys=${batch.map(encodeURIComponent).join(',')}`);
                    for (const [key, state] of Object.entries(data?.requests || {})) {
                        const item = slot(key); item.state = state;
                        if (!item.parameters) item.parameters = state.attempts?.at(-1)?.parameters || null;
                        cards.get(key)?.update();
                    }
                } catch (error) { for (const key of batch) { const card = cards.get(key); if (card) { slot(key).error = error.message; card.update(); } } }
                schedulePolling();
            }, 30);
        }
        // Background tabs throttle timers; refresh running cards as soon as the page is visible again.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            const keys = live().map(card => card.key).filter(running);
            if (keys.length) request(keys);
        });

        function schedulePolling() {
            const keys = live().map(card => card.key).filter(running);
            if (!keys.length) { clearInterval(poller); poller = null; return; }
            poller ||= setInterval(() => {
                const active = live().map(card => card.key).filter(running);
                if (active.length) request(active); else { clearInterval(poller); poller = null; }
            }, 2500);
        }

        function render(message) {
            const plan = planOf(message);
            if (!plan) return null;
            const key = plan.id, item = slot(key);
            const root = el('section', 'pi-media-request');
            root.dataset.planKey = key; root.dataset.kind = plan.kind || '';
            root.setAttribute('aria-label', t('媒体生成卡片'));
            const card = { key, plan, root, update: () => paint(card) };
            cards.set(key, card);
            paint(card);
            // A card rebuilt after a session switch or reconnect may still be running:
            // the poller stopped while the transcript was empty, so resume it here.
            if (!item.state || running(key)) request([key]);
            return root;
        }

        function parametersOf(card) { return slot(card.key).parameters || card.plan.parameters; }
        function statusLabel(attempt) {
            if (!attempt) return [t('待确认'), 'pending'];
            return { running: [t('生成中'), 'running'], done: [t('已完成'), 'done'], failed: [t('未生成'), 'failed'], uncertain: [t('结果不确定'), 'uncertain'] }[attempt.status] || [attempt.status, 'failed'];
        }

        function preview(card, model) {
            const box = el('div', 'pi-media-request-params');
            const values = parametersOf(card), defs = model?.parameters || {};
            const label = key => t(defs[key]?.label || key);
            const textKey = TEXT_KEYS.find(key => typeof values[key] === 'string');
            if (textKey) {
                const text = el('p', 'pi-media-request-text', values[textKey]);
                text.title = label(textKey);
                const toggle = el('button', 'pi-media-request-more', t('展开全文')); toggle.type = 'button';
                toggle.setAttribute('aria-expanded', 'false');
                toggle.addEventListener('click', () => {
                    const open = toggle.getAttribute('aria-expanded') !== 'true';
                    toggle.setAttribute('aria-expanded', String(open)); text.classList.toggle('expanded', open);
                    toggle.textContent = t(open ? '收起' : '展开全文');
                });
                box.append(text);
                if (values[textKey].length > 90) box.append(toggle);
            }
            const chips = el('div', 'pi-media-request-chips');
            for (const [key, value] of Object.entries(values)) {
                if (key === textKey || value === undefined || value === '' || value === null) continue;
                let shown = window.PiMediaFields?.displayValue(value) ?? value;
                if (typeof shown === 'object') shown = JSON.stringify(shown);
                shown = String(shown);
                if (shown.length > 60) shown = shown.slice(0, 57) + '…';
                const chip = el('span', 'pi-media-request-chip');
                chip.append(el('span', '', label(key)), el('strong', '', shown));
                chip.title = `${label(key)}: ${String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 2000)}`;
                chips.append(chip);
            }
            if (chips.children.length) box.append(chips);
            return box;
        }

        function result(attempt) {
            const row = el('div', `pi-media-request-result ${attempt.status}`);
            if (attempt.status === 'done' && attempt.asset && MEDIA_URL.test(attempt.asset.url)) {
                const url = attempt.asset.url, kind = attempt.asset.kind || attempt.kind;
                let media;
                if (kind === 'image') { media = el('img'); media.alt = t('生成的图片'); media.loading = 'lazy'; }
                else if (kind === 'video') { media = el('video'); media.controls = true; media.preload = 'metadata'; media.playsInline = true; }
                else { media = el('audio'); media.controls = true; media.preload = 'metadata'; }
                media.src = url; media.className = 'pi-media-request-media';
                const link = el('a', 'pi-media-request-link'); link.href = url; link.target = '_blank'; link.rel = 'noopener';
                link.append(icon(kind === 'image' ? 'fa-up-right-from-square' : 'fa-download'), document.createTextNode(t(kind === 'image' ? '查看原图' : '下载')));
                if (kind !== 'image') link.download = '';
                if (kind === 'image') { const open = el('a', 'pi-media-request-image-link'); open.href = url; open.target = '_blank'; open.rel = 'noopener'; open.append(media); row.append(open); }
                else row.append(media);
                const meta = el('div', 'pi-media-request-meta');
                meta.append(el('span', '', `${attempt.modelName || attempt.modelId || ''}${attempt.finishedAt ? ' · ' + new Date(attempt.finishedAt).toLocaleTimeString(globalThis.PiI18n?.locale || 'zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}`), link);
                row.append(meta);
            } else if (attempt.status === 'running') {
                const stages = { submitting: t('正在提交'), polling: t('正在查询任务'), downloading: t('正在下载结果') };
                row.append(icon('fa-spinner fa-spin'), el('span', '', `${stages[attempt.progress?.stage] || t('正在生成，可以离开此页面，回来后会显示结果')}${attempt.progress?.taskId ? ' · ' + attempt.progress.taskId : ''}`));
            } else if (attempt.status === 'failed') {
                row.append(icon('fa-circle-exclamation'), el('span', '', t('没有开始生成，未提交给服务：{0}', t(attempt.error || ''))));
            } else {
                row.append(icon('fa-triangle-exclamation'), el('span', '', t('结果不确定：{0}。请先在多媒体实验室的生成记录里核对，避免重复计费。', t(attempt.error || ''))));
            }
            return row;
        }

        function paint(card) {
            const item = slot(card.key), plan = card.plan;
            const model = card.model;
            const attempts = item.state?.attempts || [];
            const last = attempts.at(-1);
            const busy = item.busy || last?.status === 'running';
            const root = card.root;
            const focused = root.contains(document.activeElement) ? document.activeElement : null;
            // Keep an open editor (and its unsaved values) while only actions or errors change.
            if (item.editing && card.form?.isConnected && root.contains(card.form)) {
                card.error.textContent = item.error || ''; card.error.hidden = !item.error;
                paintActions(card, model, attempts, last, busy); return;
            }
            root.replaceChildren();
            root.dataset.state = statusLabel(last)[1];
            const header = el('header');
            header.append(icon(ICONS[plan.kind] || 'fa-wand-magic-sparkles'));
            const title = el('div', 'pi-media-request-title');
            title.append(el('strong', '', plan.summary || t('媒体生成')), el('span', '', `${t(KIND_NAMES[plan.kind] || plan.kind || '')} · ${model?.name || plan.modelId}`));
            const [label, stateName] = statusLabel(last);
            const pill = el('span', `pi-media-request-state ${stateName}`, label);
            header.append(title, pill);
            root.append(header);
            if (item.editing) {
                const form = el('form', 'lab-fields pi-media-request-form');
                form.addEventListener('submit', event => event.preventDefault());
                if (model && window.PiMediaFields) window.PiMediaFields.render(form, model, parametersOf(card));
                else form.append(el('p', 'pi-media-request-note', t('无法读取这个模型的参数定义；它可能已被移除或尚未配置。')));
                card.form = form; root.append(form);
            } else { card.form = null; root.append(preview(card, model)); }
            const notes = attempts.length ? [] : [...(plan.warnings || []).map(text => t(text))];
            if (item.notice) notes.unshift(item.notice);
            if (!attempts.length) notes.push(t('点确认后才会调用模型。'));
            if (model && !model.executable) notes.push(t('这个模型还没有可用的执行配置，请先在模型接入里完成配置。'));
            for (const text of notes) root.append(el('p', 'pi-media-request-note', text));
            const error = el('p', 'pi-media-request-error'); error.setAttribute('role', 'alert'); error.textContent = item.error || ''; error.hidden = !item.error;
            root.append(error); card.error = error;
            // Newest result first, then the actions; while editing, actions stay next to the form.
            const actions = el('div', 'pi-media-request-actions'); card.actions = actions;
            const results = el('div', 'pi-media-request-results');
            for (const attempt of [...attempts].reverse()) results.append(result(attempt));
            if (item.editing) root.append(actions, ...(attempts.length ? [results] : []));
            else root.append(...(attempts.length ? [results] : []), actions);
            paintActions(card, model, attempts, last, busy);
            if (focused && !root.contains(focused)) root.querySelector('.pi-media-request-actions button:not(:disabled)')?.focus({ preventScroll: true });
        }

        function paintActions(card, model, attempts, last, busy) {
            const item = slot(card.key), actions = card.actions;
            if (!actions) return;
            actions.replaceChildren();
            const button = (text, name, className, handler) => {
                const node = el('button', className); node.type = 'button'; node.append(icon(name), document.createTextNode(text));
                node.addEventListener('click', handler); actions.append(node); return node;
            };
            const disabled = busy || (model && !model.executable);
            if (busy) { button(item.busy ? t('正在提交…') : t('生成中…'), 'fa-spinner fa-spin', 'lab-primary', () => {}).disabled = true; return; }
            const again = attempts.length > 0;
            const primaryText = !again ? t('确认生成') : item.armed ? (last?.status === 'uncertain' ? t('确认再生成（上次可能已计费）') : t('确认再生成（会再次计费）')) : t('再生成一次');
            const primary = button(primaryText, item.armed || !again ? 'fa-play' : 'fa-rotate-right', 'lab-primary', () => {
                if (again && !item.armed) {
                    item.armed = true; paint(card);
                    clearTimeout(item.armTimer); item.armTimer = setTimeout(() => { item.armed = false; card.update(); }, 8000);
                    return;
                }
                submit(card, again);
            });
            primary.disabled = Boolean(disabled);
            if (item.editing) button(t('取消修改'), 'fa-xmark', 'lab-secondary', () => { item.editing = false; item.error = ''; paint(card); });
            else button(t('修改参数'), 'fa-pen', 'lab-secondary', async () => {
                try { card.model = (await models()).get(card.plan.modelId) || null; } catch (error) { item.error = error.message; }
                item.editing = true; item.armed = false; paint(card);
                card.form?.querySelector('textarea, input, select')?.focus({ preventScroll: true });
            }).disabled = Boolean(busy);
        }

        async function submit(card, again) {
            const item = slot(card.key);
            if (item.busy) return;
            let parameters;
            try { parameters = item.editing && card.form ? window.PiMediaFields.collect(card.form) : parametersOf(card); }
            catch (error) { item.error = error.message; paint(card); return; }
            item.busy = true; item.error = ''; item.notice = ''; item.armed = false; clearTimeout(item.armTimer); paint(card);
            try {
                const data = await fetch('/api/pi/media/chat/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ key: card.key, modelId: card.plan.modelId, parameters, confirmed: true, ...(again ? { again: true } : {}) }) });
                if (data.status === 'changed') {
                    item.parameters = data.parameters; item.notice = t('服务端调整了部分参数（如默认值或格式），请核对后再确认。');
                    if (item.editing && card.model) item.editing = false;
                } else { item.parameters = parameters; item.editing = false; }
                if (data.state) item.state = data.state;
            } catch (error) {
                item.error = error.message;
                if (error.data?.state) item.state = error.data.state;
            } finally {
                // The transcript may have been rebuilt during the request; paint the card that is shown.
                item.busy = false; paint(cards.get(card.key)?.root.isConnected ? cards.get(card.key) : card); schedulePolling();
            }
        }

        // Model names and parameter labels come from the live catalog.
        const original = render;
        return {
            render(message) {
                const root = original(message);
                if (root) models().then(map => { const card = cards.get(root.dataset.planKey); if (card && card.root === root) { card.model = map.get(card.plan.modelId) || null; card.update(); } }, () => {});
                return root;
            },
            planOf
        };
    }

    window.PiMediaRequests = { create, planOf };
})();
