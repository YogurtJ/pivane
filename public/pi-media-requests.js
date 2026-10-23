// In-chat media cards. A native pivane-media-plan origin survives cancelled tool
// results; older successful media tool results remain compatible card sources.
// The user reviews or edits parameters and confirms there, and the server
// reviews and executes one lab ticket.
// State lives in the server journal keyed by plan id, so refresh, another tab or
// the phone shows the same result instead of offering a duplicate submission.
(() => {
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const KEY = /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const TOOLS = new Set(['media_generate', 'media_plan_request']);
    const MEDIA_URL = /^\/(images|videos|audio)\/[^/?#\\]+(?:\?[^#]*)?$/;
    const TEXT_KEYS = ['prompt', 'text', 'input'];
    const STATUS_TIMEOUT_MS = 8000;
    const LIVE_ORIGIN_STATUS_CHECKS = 12;
    const ICONS = { image: 'fa-image', video: 'fa-film', tts: 'fa-volume-high' };
    const KIND_NAMES = { image: '图像', video: '视频', tts: '语音' };
    const el = (tag, className = '', text = '') => { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; };
    const icon = name => { const node = el('i', `fa-solid ${name}`); node.setAttribute('aria-hidden', 'true'); return node; };

    const SOURCE_TYPE = 'pivane-media-plan';
    function sourceMessage(entry) {
        if (entry?.type !== 'custom' || entry.customType !== SOURCE_TYPE || entry.data?.version !== 1 || typeof entry.data.toolCallId !== 'string') return null;
        return { role: 'custom', customType: SOURCE_TYPE, display: false, details: entry.data, content: [], timestamp: Date.parse(entry.timestamp) || 0 };
    }
    function planOf(message) {
        const native = message?.role === 'custom' && message.customType === SOURCE_TYPE && message.details?.version === 1;
        if (!native && (message?.role !== 'toolResult' || message.isError || !TOOLS.has(message.toolName))) return null;
        const plan = message.details?.plan;
        if (!plan || !KEY.test(plan.id || '') || typeof plan.modelId !== 'string' || !plan.parameters || typeof plan.parameters !== 'object' || Array.isArray(plan.parameters)) return null;
        return plan;
    }

    function create({ fetch }) {
        const memory = new Map();   // Mounted-card state; pending writes retain only their own state.
        const cards = new Map();    // key -> WeakRef(card), never an owner of detached DOM.
        const mounted = new WeakMap(); // A connected root owns its card; detached cycles can be collected.
        const inFlight = new Map(); // key -> shared read-only batch
        const queued = new Set();
        let catalog = null, catalogModels = null, queueTimer = null, poller = null, generation = 0;

        const models = () => catalog ||= fetch('/api/pi/media/lab').then(data => {
            catalogModels = new Map((data?.models || []).map(model => [model.id, model]));
            for (const card of live()) applyCatalog(card);
            return catalogModels;
        }, error => {
            catalog = null;
            for (const card of live()) if (memory.get(card.key)?.editRequested) applyCatalog(card, error);
            return null;
        });
        const slot = key => { if (!memory.has(key)) memory.set(key, { state: null, parameters: null, editing: false, error: '', readTimeoutError: '', notice: '', armed: false, busy: false, revision: 0 }); return memory.get(key); };
        const current = key => cards.get(key)?.deref();
        const running = key => memory.get(key)?.state?.attempts?.some(attempt => attempt.status === 'running' || attempt.status === 'queued');
        const tracking = key => running(key) || memory.get(key)?.originChecks > 0 && !memory.get(key)?.state?.attempts?.length;
        const live = () => [...cards.keys()].map(current).filter(card => card?.root.isConnected);
        const update = key => { const card = current(key); if (card?.root.isConnected) card.update(); };

        // A view reset invalidates reads, but never cancels a confirmed server mutation.
        function prune() {
            const batches = new Set(inFlight.values());
            for (const [key, ref] of cards) {
                if (ref.deref()?.root.isConnected) continue;
                cards.delete(key); queued.delete(key); inFlight.delete(key);
                const item = memory.get(key);
                clearTimeout(item?.armTimer);
                if (!item?.busy) memory.delete(key);
                else { item.editing = false; item.editRequested = false; item.armed = false; }
            }
            for (const batch of batches) {
                if (batch.keys.some(key => inFlight.get(key) === batch)) continue;
                for (const key of batch.keys) if (inFlight.get(key) === batch) inFlight.delete(key);
                batch.controller.abort();
            }
            if (!queued.size) { clearTimeout(queueTimer); queueTimer = null; }
            if (!live().some(card => tracking(card.key))) { clearInterval(poller); poller = null; }
        }

        function reset() {
            generation++;
            cards.clear(); queued.clear();
            clearTimeout(queueTimer); queueTimer = null;
            clearInterval(poller); poller = null;
            for (const batch of new Set(inFlight.values())) batch.controller.abort();
            inFlight.clear();
            for (const [key, item] of memory) {
                clearTimeout(item.armTimer);
                if (!item.busy) memory.delete(key);
                else { item.editing = false; item.editRequested = false; item.armed = false; }
            }
        }

        // Native transcript replacements also release cards without an explicit host call.
        if (typeof MutationObserver !== 'undefined') new MutationObserver(records => {
            if (records.some(record => record.removedNodes.length)) prune();
        }).observe(document, { childList: true, subtree: true });

        function request(keys, fresh = false) {
            for (const key of keys) {
                const item = memory.get(key);
                if (item?.busy) continue;
                // An authoritative transcript invalidates earlier reads, even if
                // a status request is still in flight. Queue its replacement.
                if (fresh && item) item.revision++;
                if (fresh || !inFlight.has(key)) queued.add(key);
            }
            if (queueTimer || !queued.size) return;
            queueTimer = setTimeout(flush, 30);
        }

        async function flush() {
            queueTimer = null;
            prune();
            const keys = [...queued].filter(key => !inFlight.has(key)).slice(0, 100);
            for (const key of keys) queued.delete(key);
            if (!keys.length) return;
            const batch = { keys, controller: new AbortController(), generation, timedOut: false,
                revisions: new Map(keys.map(key => [key, memory.get(key)?.revision])) };
            for (const key of keys) {
                inFlight.set(key, batch);
                const item = memory.get(key);
                if (item?.originChecks > 0) item.originChecks--;
            }
            if (queued.size) request([]);
            const valid = key => inFlight.get(key) === batch && batch.generation === generation &&
                cards.has(key) && memory.get(key)?.revision === batch.revisions.get(key) && !memory.get(key)?.busy;
            let abortRead;
            const interrupted = new Promise((_, reject) => {
                abortRead = () => reject(new Error('Aborted'));
                batch.controller.signal.addEventListener('abort', abortRead, { once: true });
            });
            // Bound only status reads. Racing the abort also releases the gate if a fetch adapter ignores its signal.
            const deadline = setTimeout(() => { batch.timedOut = true; batch.controller.abort(); }, STATUS_TIMEOUT_MS);
            try {
                const data = await Promise.race([
                    fetch(`/api/pi/media/chat/requests?keys=${keys.map(encodeURIComponent).join(',')}`, { signal: batch.controller.signal }),
                    interrupted
                ]);
                for (const key of keys) {
                    if (!valid(key) || batch.controller.signal.aborted || !data?.requests?.[key]) continue;
                    const item = memory.get(key), state = data.requests[key]; item.state = state;
                    if (state.attempts?.length) item.originChecks = 0;
                    if (item.error === item.readTimeoutError) item.error = '';
                    item.readTimeoutError = '';
                    if (!item.parameters) item.parameters = state.attempts?.at(-1)?.parameters || null;
                    update(key);
                }
            } catch (error) {
                if (!batch.controller.signal.aborted || batch.timedOut) for (const key of keys) if (valid(key)) {
                    const item = memory.get(key);
                    item.error = batch.timedOut ? (item.readTimeoutError = t('媒体状态查询超时')) : error.message;
                    update(key);
                }
            } finally {
                clearTimeout(deadline);
                batch.controller.signal.removeEventListener('abort', abortRead);
                for (const key of keys) if (inFlight.get(key) === batch) inFlight.delete(key);
                prune(); schedulePolling();
                if (queued.size) request([]);
            }
        }
        // Background tabs throttle timers; refresh active and newly appended cards when visible again.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState !== 'visible') return;
            prune();
            const keys = live().map(card => card.key).filter(tracking);
            if (keys.length) request(keys);
        });

        function schedulePolling() {
            const keys = live().map(card => card.key).filter(tracking);
            if (!keys.length) { clearInterval(poller); poller = null; return; }
            poller ||= setInterval(() => {
                prune();
                const active = live().map(card => card.key).filter(tracking);
                if (active.length) request(active);
            }, 2500);
        }

        function render(message, { live: appended = false } = {}) {
            const plan = planOf(message);
            if (!plan) return null;
            const key = plan.id, item = slot(key);
            if (current(key)?.root.isConnected) return null;
            // Native append precedes execute/review. Follow that empty-journal
            // window for a bounded number of GETs; never rearm on duplicate events.
            if (appended && message.role === 'custom' && item.originChecks == null) item.originChecks = LIVE_ORIGIN_STATUS_CHECKS;
            const root = el('section', 'pi-media-request');
            root.dataset.planKey = key; root.dataset.kind = plan.kind || '';
            root.setAttribute('aria-label', t('媒体生成卡片'));
            const card = { key, plan, root, model: catalogModels?.get(plan.modelId) || null, update: () => paint(card) };
            mounted.set(root, card);
            cards.set(key, new WeakRef(card));
            paint(card);
            // A card rebuilt after a session switch or reconnect may still be running:
            // the poller stopped while the transcript was empty, so resume it here.
            if (!item.state || tracking(key)) request([key]);
            return root;
        }

        function parametersOf(card) { return slot(card.key).parameters || card.plan.parameters; }
        function statusLabel(attempt) {
            if (!attempt) return [t('待确认'), 'pending'];
            return { queued: [t('排队中'), 'queued'], running: [t('生成中'), 'running'], done: [t('已完成'), 'done'], failed: [attempt.remoteTerminal === true ? t('生成失败') : t('未生成'), 'failed'],
                uncertain: [t('结果不确定'), 'uncertain'], cancelled: [t('已取消'), 'cancelled'] }[attempt.status] || [attempt.status, 'failed'];
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
            // Reference images (image to edit, first frame...) are shown, so the user sees exactly what is sent.
            const refs = el('div', 'pi-media-request-refs');
            const sourceUrl = window.PiMediaFields?.sourceUrl || (() => '');
            const chips = el('div', 'pi-media-request-chips');
            for (const [key, value] of Object.entries(values)) {
                if (key === textKey || value === undefined || value === '' || value === null) continue;
                const items = Array.isArray(value) ? value : [value];
                if (items.length && items.every(item => sourceUrl(item))) {
                    const isVideo = defs[key]?.type === 'video';
                    items.forEach((item, index) => {
                        const figure = el('figure', 'pi-media-request-ref' + (isVideo ? ' is-video' : ''));
                        const media = el(isVideo ? 'video' : 'img');
                        if (isVideo) { media.preload = 'metadata'; media.muted = true; media.playsInline = true; media.controls = true; }
                        else { media.alt = `${label(key)}${items.length > 1 ? ' ' + (index + 1) : ''}`; media.loading = 'lazy'; }
                        media.src = sourceUrl(item);
                        figure.append(media, el('figcaption', '', `${label(key)}${items.length > 1 ? ' ' + (index + 1) : ''}`));
                        refs.append(figure);
                    });
                    continue;
                }
                let shown = window.PiMediaFields?.displayValue(value) ?? value;
                if (typeof shown === 'object') shown = JSON.stringify(shown);
                shown = String(shown);
                if (shown.length > 60) shown = shown.slice(0, 57) + '…';
                const chip = el('span', 'pi-media-request-chip');
                chip.append(el('span', '', label(key)), el('strong', '', shown));
                chip.title = `${label(key)}: ${String(typeof value === 'object' ? JSON.stringify(value) : value).slice(0, 2000)}`;
                chips.append(chip);
            }
            if (refs.children.length) box.append(refs);
            if (chips.children.length) box.append(chips);
            return box;
        }

        function elapsed(from, to) {
            const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from || '');
            if (!Number.isFinite(ms) || ms < 0) return '';
            const seconds = Math.round(ms / 1000);
            return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
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
            } else if (attempt.status === 'queued') {
                row.append(icon('fa-hourglass-half'), el('span', '', attempt.position > 1 ? t('排队中，前面还有 {0} 个请求；有空位后自动开始，还没有提交给服务', attempt.position - 1) : t('排队中，有空位后自动开始；还没有提交给服务')));
            } else if (attempt.status === 'running') {
                const stages = { submitting: t('已提交，等待服务返回结果'), polling: t('正在查询任务'), downloading: t('正在下载结果') };
                const waited = elapsed(attempt.resumedAt || attempt.startedAt);
                row.append(icon('fa-spinner fa-spin'), el('span', '', `${stages[attempt.progress?.stage] || t('正在生成，可以离开此页面，回来后会显示结果')}${waited ? ' · ' + t('已等待 {0}', waited) : ''}${attempt.progress?.taskId ? ' · ' + attempt.progress.taskId : ''}`));
            } else if (attempt.status === 'cancelled') {
                row.append(icon('fa-ban'), el('span', '', t('已取消排队，没有提交给服务')));
            } else if (attempt.status === 'failed') {
                row.append(icon('fa-circle-exclamation'), el('span', '', attempt.remoteTerminal === true
                    ? t('服务已确认生成失败或取消：{0}', t(attempt.error || ''))
                    : t('没有开始生成，未提交给服务：{0}', t(attempt.error || ''))));
            } else if (attempt.canResume) {
                row.append(icon('fa-triangle-exclamation'), el('span', '', t('已保留远端任务 {0}。可继续查询并取回结果，不会重新提交生成。', attempt.taskId || '')), el('small', '', t(attempt.error || '')));
            } else if (/timed out/i.test(attempt.error || '')) {
                row.append(icon('fa-triangle-exclamation'), el('span', '', t('等待超过这个模型设置的最长时间（{0}）。服务商可能仍会完成并计费，但这次结果拿不回来；请先在多媒体实验室的生成记录里核对。经常超时可在模型接入里调大“本次请求最长等待”。', elapsed(attempt.startedAt, attempt.finishedAt) || '?')));
            } else {
                row.append(icon('fa-triangle-exclamation'), el('span', '', t('结果不确定：{0}。请先在多媒体实验室的生成记录里核对，避免重复计费。', t(attempt.error || ''))));
            }
            return row;
        }

        function reconcile(parent, children) {
            const keep = new Set(children);
            for (const child of [...parent.childNodes]) if (!keep.has(child)) child.remove();
            let cursor = parent.firstChild;
            for (const child of children) {
                if (child === cursor) cursor = cursor.nextSibling;
                else parent.insertBefore(child, cursor);
            }
            while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
        }

        function paint(card) {
            const item = slot(card.key), plan = card.plan;
            const model = card.model;
            const attempts = item.state?.attempts || [];
            const last = attempts.at(-1);
            const busy = item.busy || last?.status === 'running' || last?.status === 'queued';
            const root = card.root;
            const focused = root.contains(document.activeElement) ? document.activeElement : null;
            // Keep an open editor (and its unsaved values) while only actions or errors change.
            if (item.editing && card.form?.isConnected && root.contains(card.form)) {
                card.error.textContent = item.error || ''; card.error.hidden = !item.error;
                paintActions(card, model, attempts, last, busy); return;
            }
            const children = [];
            root.dataset.state = statusLabel(last)[1];
            const header = el('header');
            header.append(icon(ICONS[plan.kind] || 'fa-wand-magic-sparkles'));
            const title = el('div', 'pi-media-request-title');
            title.append(el('strong', '', plan.summary || t('媒体生成')), el('span', '', `${t(KIND_NAMES[plan.kind] || plan.kind || '')} · ${model?.name || plan.modelId}`));
            const [label, stateName] = statusLabel(last);
            const pill = el('span', `pi-media-request-state ${stateName}`, label);
            header.append(title, pill);
            children.push(header);
            if (item.editing) {
                const form = el('form', 'lab-fields pi-media-request-form');
                form.addEventListener('submit', event => event.preventDefault());
                if (model && window.PiMediaFields) window.PiMediaFields.render(form, model, parametersOf(card));
                else form.append(el('p', 'pi-media-request-note', t('无法读取这个模型的参数定义；它可能已被移除或尚未配置。')));
                card.form = form; children.push(form);
            } else { card.form = null; children.push(preview(card, model)); }
            const notes = attempts.length ? [] : [...(plan.warnings || []).map(text => t(text))];
            if (item.notice) notes.unshift(item.notice);
            if (!attempts.length) notes.push(t('点确认后才会调用模型。'));
            if (model && !model.executable) notes.push(t('这个模型还没有可用的执行配置，请先在模型接入里完成配置。'));
            for (const text of notes) children.push(el('p', 'pi-media-request-note', text));
            const error = el('p', 'pi-media-request-error'); error.setAttribute('role', 'alert'); error.textContent = item.error || ''; error.hidden = !item.error;
            children.push(error); card.error = error;
            // Newest result first, then the actions; while editing, actions stay next to the form.
            const actions = el('div', 'pi-media-request-actions'); card.actions = actions;
            // Newest attempt and earlier finished media stay visible; earlier problems fold away.
            const results = card.results ||= el('div', 'pi-media-request-results');
            const previous = card.completed || new Map(), completed = new Map();
            const resultOf = attempt => {
                if (attempt.status !== 'done' || !attempt.id) return result(attempt);
                const signature = JSON.stringify([attempt.asset, attempt.kind, attempt.modelName, attempt.modelId, attempt.finishedAt]);
                const cached = previous.get(attempt.id);
                const entry = cached?.signature === signature ? cached : { signature, node: result(attempt) };
                completed.set(attempt.id, entry);
                return entry.node;
            };
            const rows = [], newest = [...attempts].reverse(), earlier = newest.slice(1).filter(attempt => attempt.status !== 'done');
            for (const attempt of newest) if (attempt === newest[0] || attempt.status === 'done') rows.push(resultOf(attempt));
            if (earlier.length) {
                const fold = el('details', 'pi-media-request-earlier');
                fold.append(el('summary', '', t('更早的 {0} 次未完成尝试', earlier.length)), ...earlier.map(result));
                rows.push(fold);
            }
            card.completed = completed;
            reconcile(results, rows);
            if (item.editing) children.push(actions, ...(attempts.length ? [results] : []));
            else children.push(...(attempts.length ? [results] : []), actions);
            reconcile(root, children);
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
            if (!item.busy && last?.status === 'queued') {
                button(t('排队中…'), 'fa-hourglass-half', 'lab-primary', () => {}).disabled = true;
                button(t('取消排队'), 'fa-xmark', 'lab-secondary', () => cancel(card));
                return;
            }
            if (busy) { button(item.busy ? t('正在提交…') : t('生成中…'), 'fa-spinner fa-spin', 'lab-primary', () => {}).disabled = true; return; }
            const canResume = last?.canResume && !item.editing;
            if (canResume) button(t('继续查询原任务'), 'fa-magnifying-glass', 'lab-primary', () => resume(card)).disabled = Boolean(disabled);
            const again = attempts.length > 0;
            // Nothing was ever sent (cancelled or not started): a single confirmation is enough.
            const charged = attempts.some(attempt => attempt.remoteTerminal === true || !['failed', 'cancelled'].includes(attempt.status));
            const primaryText = !charged ? t('确认生成') : item.armed ? (last?.status === 'uncertain' || last?.remoteTerminal === true ? t('确认再生成（上次可能已计费）') : t('确认再生成（会再次计费）')) : t('再生成一次');
            const primary = button(primaryText, item.armed || !charged ? 'fa-play' : 'fa-rotate-right', canResume ? 'lab-secondary' : 'lab-primary', () => {
                if (charged && !item.armed) {
                    item.armed = true; paint(card);
                    const key = card.key;
                    clearTimeout(item.armTimer); item.armTimer = setTimeout(() => { item.armed = false; update(key); }, 8000);
                    return;
                }
                submit(card, again);
            });
            primary.disabled = Boolean(disabled);
            if (item.editing) button(t('取消修改'), 'fa-xmark', 'lab-secondary', () => { item.editing = false; item.error = ''; paint(card); });
            else button(t('修改参数'), 'fa-pen', 'lab-secondary', () => edit(card)).disabled = Boolean(busy);
        }

        function applyCatalog(card, error) {
            const item = memory.get(card.key);
            if (!item) return;
            card.model = catalogModels?.get(card.plan.modelId) || null;
            const openEditor = item.editRequested;
            if (openEditor) {
                item.editRequested = false; item.editing = true; item.armed = false;
                if (error) item.error = error.message;
            }
            paint(card);
            if (openEditor) card.form?.querySelector('textarea, input, select')?.focus({ preventScroll: true });
        }

        function edit(card) {
            const item = slot(card.key);
            item.editRequested = true;
            if (catalogModels) applyCatalog(card);
            else models();
        }

        function submit(card, again) {
            const item = slot(card.key);
            if (item.busy) return;
            let parameters;
            try { parameters = item.editing && card.form ? window.PiMediaFields.collect(card.form) : parametersOf(card); }
            catch (error) { item.error = error.message; paint(card); return; }
            const key = card.key;
            mutate(key, item, '/api/pi/media/chat/requests', { key, modelId: card.plan.modelId, parameters, confirmed: true, ...(again ? { again: true } : {}) }, parameters);
        }

        function resume(card) {
            mutate(card.key, slot(card.key), '/api/pi/media/chat/requests/resume', { key: card.key, confirmed: true });
        }

        function cancel(card) {
            mutate(card.key, slot(card.key), '/api/pi/media/chat/requests/cancel', { key: card.key });
        }

        // Only key and plain state cross the await. Detached cards/forms are never retained
        // by a write, and completion can update only the currently registered live card.
        async function mutate(key, item, url, body, parameters) {
            if (item.busy) return;
            item.busy = true; item.revision++; queued.delete(key);
            item.error = ''; item.notice = ''; item.editRequested = false; item.armed = false; clearTimeout(item.armTimer); update(key);
            try {
                const data = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
                if (parameters) {
                    if (data.status === 'changed') {
                        item.parameters = data.parameters; item.notice = t('服务端调整了部分参数（如默认值或格式），请核对后再确认。');
                    } else item.parameters = data.parameters || parameters;
                    item.editing = false;
                }
                if (data.state) item.state = data.state;
            } catch (error) {
                item.error = error.message;
                if (error.data?.state) item.state = error.data.state;
            } finally {
                item.busy = false; item.revision++;
                update(key); prune();
                if (!cards.has(key)) memory.delete(key);
                schedulePolling();
            }
        }

        // Model names and parameter labels come from the live catalog.
        const original = render;
        return {
            render(message, options) {
                const root = original(message, options);
                if (root) models();
                return root;
            },
            planOf,
            sourceMessage,
            // Revalidate mounted cards even when transcript DOM and cached empty
            // attempts were retained. Status reads preserve edits and pending writes.
            refresh(messages) {
                const keys = [...new Set(messages.map(message => planOf(message)?.id).filter(key => key && current(key)?.root.isConnected))];
                request(keys, true);
            },
            sources(messages) {
                const selected = new Map();
                messages.forEach((message, index) => {
                    const plan = planOf(message);
                    if (plan && (!selected.has(plan.id) || message.role === 'custom')) selected.set(plan.id, index);
                });
                return new Set(selected.values());
            },
            // After partial transcript removals; automatic DOM observation also prunes.
            prune,
            // Before a conversation replacement. Confirmed writes remain busy until settled.
            reset
        };
    }

    window.PiMediaRequests = { create, planOf, sourceMessage };
})();
