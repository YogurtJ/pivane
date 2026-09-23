/* Session model picker. Runtime owns the selection; storage contains display preferences only. */
(() => {
    'use strict';
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, i) => values[i] ?? `{${i}}`));
    const FAVORITES = 'pivane.models.favorites';
    const RECENT = 'pivane.models.recent';
    const MIGRATION = 'pivane.models.favoritesMigration';
    const MIGRATED = 'pivane.models.favoritesMigrated';
    const keyOf = model => JSON.stringify([model.provider, model.id]);
    const newMigrationId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    async function favoritesApi(url, options) {
        const response = await (window.WorkspaceAccess?.fetch || fetch)(url, options);
        const data = await response.json().catch(() => null);
        if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
        return data;
    }
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    };
    function readKeys(key, limit) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw || raw.length > 1024 * 1024) return [];
            const values = JSON.parse(raw);
            if (!Array.isArray(values)) return [];
            return [...new Set(values.filter(value => {
                if (typeof value !== 'string') return false;
                try { const pair = JSON.parse(value); return Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string' && part.length > 0); }
                catch { return false; }
            }))].slice(0, limit);
        } catch { return []; }
    }
    class PiModelPicker {
        constructor({ button, onSelect, api }) {
            this.api = api || favoritesApi;
            this.revision = -1;
            this.favoriteReady = false;
            this.favoriteBusy = false;
            this.migrationConfirmed = false;
            this.syncMessage = '';
            this.button = button;
            this.onSelect = onSelect;
            this.models = [];
            this.current = null;
            this.favorites = readKeys(FAVORITES, 5000);
            this.recent = readKeys(RECENT, 5);
            this.all = false;
            this.limit = 60;
            this.label = node('strong', 'pi-model-trigger-label', t('等待会话'));
            button.replaceChildren(this.label, node('b', 'pi-model-trigger-chevron', '⌄'));
            button.setAttribute('aria-haspopup', 'dialog');
            button.setAttribute('aria-expanded', 'false');
            button.setAttribute('aria-controls', 'pi-model-dialog');
            this.dialog = node('dialog', 'pi-model-dialog');
            this.dialog.id = 'pi-model-dialog';
            this.dialog.setAttribute('aria-labelledby', 'pi-model-dialog-title');
            const header = node('div', 'pi-model-dialog-header');
            const title = node('h2', '', t('选择模型'));
            title.id = 'pi-model-dialog-title';
            const close = node('button', 'pi-model-close', '×');
            close.type = 'button';
            close.setAttribute('aria-label', t('关闭'));
            close.addEventListener('click', () => this.close());
            this.closeButton = close;
            close.autofocus = true;
            header.append(title, close);
            this.search = node('input', 'pi-model-search');
            this.search.type = 'search';
            this.search.placeholder = t('搜索模型或供应商…');
            this.search.setAttribute('aria-label', this.search.placeholder);
            this.search.autocomplete = 'off';
            this.search.spellcheck = false;
            this.results = node('div', 'pi-model-results');
            this.results.id = 'pi-model-results';
            this.status = node('p', 'pi-model-status');
            this.status.setAttribute('role', 'status');
            this.toggle = node('button', 'pi-model-all');
            this.toggle.type = 'button';
            this.toggle.setAttribute('aria-controls', this.results.id);
            this.toggle.addEventListener('click', () => { this.all = !this.all; this.limit = 60; this.render(); });
            const hint = node('p', 'pi-model-hint', t('常用模型在此实例的设备间共享；最近使用保存在当前浏览器。'));
            this.dialog.append(header, this.search, this.results, this.status, this.toggle, hint);
            document.body.append(this.dialog);
            button.addEventListener('click', () => this.open());
            this.search.addEventListener('input', () => { this.limit = 60; this.render(); });
            this.dialog.addEventListener('close', () => {
                button.setAttribute('aria-expanded', 'false');
                clearInterval(this.syncTimer);
                if (innerWidth <= 680 && !button.getClientRects().length) document.getElementById('pi-mobile-context-trigger')?.focus({ preventScroll: true });
            });
            this.dialog.addEventListener('click', event => {
                if (event.target !== this.dialog) return;
                const rect = this.dialog.getBoundingClientRect();
                if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) this.close();
            });
            this.dialog.addEventListener('keydown', event => {
                if (event.isComposing) return;
                if (event.target === this.search && event.key === 'Enter') {
                    event.preventDefault(); this.results.querySelector('.pi-model-option')?.click(); return;
                }
                if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
                const options = [...this.results.querySelectorAll('.pi-model-option')];
                const index = options.indexOf(document.activeElement);
                if (event.target !== this.search && index < 0) return;
                event.preventDefault();
                const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : options.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                options[next]?.focus();
            });
            window.addEventListener('resize', () => { if (this.dialog.open) this.position(); });
            window.addEventListener('storage', event => {
                if (event.key === FAVORITES || event.key === RECENT || event.key === null) {
                    if (!this.favoriteReady) this.favorites = readKeys(FAVORITES, 5000);
                    this.recent = readKeys(RECENT, 5);
                    if (this.dialog.open) { this.render(); void this.refreshFavorites(); }
                }
            });
            window.addEventListener('focus', () => { if (this.started) void this.refreshFavorites(); });
            document.addEventListener('visibilitychange', () => { if (!document.hidden && this.started) void this.refreshFavorites(); });
        }
        applyFavorites(data) {
            if (data?.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 || !Array.isArray(data.favorites)
                || data.favorites.length > 5000 || data.favorites.some(model => typeof model?.provider !== 'string' || typeof model?.modelId !== 'string')) throw new Error('Invalid favorites response');
            if (data.revision < this.revision) return;
            this.revision = data.revision;
            this.favorites = data.favorites.map(model => keyOf({ provider: model.provider, id: model.modelId }));
            this.favoriteReady = true;
        }
        refreshFavorites() {
            if (this.favoriteBusy) return Promise.resolve();
            if (this.syncPromise) return this.syncPromise;
            const before = [this.revision, this.favoriteReady, this.syncMessage];
            this.syncPromise = (async () => {
                try {
                    let data = await this.api('/api/pi/settings/model-favorites', { signal: AbortSignal.timeout(10000) });
                    // Merge each old browser once. Server-side receipts and removal markers
                    // make a lost response or a later device import safe to repeat.
                    const legacy = readKeys(FAVORITES, 5000);
                    // A browser marker alone does not prove this instance still has the
                    // receipt. Reconfirm once per page; duplicate imports are read-only.
                    if (!this.migrationConfirmed && legacy.length && !this.migrationFailed) {
                        let migrationId;
                        try {
                            migrationId = localStorage.getItem(MIGRATION) || newMigrationId();
                            localStorage.setItem(MIGRATION, migrationId);
                        } catch { throw new Error(t('浏览器无法保存模型偏好，本次页面内仍可使用。')); }
                        try {
                            data = await this.api('/api/pi/settings/model-favorites', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ action: 'import', migrationId, models: legacy.map(key => { const [provider, modelId] = JSON.parse(key); return { provider, modelId }; }) }) });
                            // Do not delete the legacy copy. This marker is only written after confirmation.
                            try { localStorage.setItem(MIGRATED, '1'); } catch {}
                            this.migrationConfirmed = true;
                        } catch (error) { this.migrationFailed = true; throw error; }
                    }
                    this.applyFavorites(data);
                    this.syncMessage = this.migrationFailed ? t('旧收藏尚未确认同步，请重新打开选择器核对。') : '';
                } catch {
                    this.syncMessage = t('常用模型同步暂不可用，请重新打开选择器核对。');
                } finally {
                    this.syncPromise = null;
                    if (this.dialog.open && (before[0] !== this.revision || before[1] !== this.favoriteReady || before[2] !== this.syncMessage)) this.render({ preserveScroll: true });
                }
            })();
            return this.syncPromise;
        }
        async setFavorite(model, favorite) {
            if (!this.favoriteReady || this.favoriteBusy) return;
            this.favoriteBusy = true;
            this.syncMessage = t('正在保存常用模型…'); this.render();
            try {
                const data = await this.api('/api/pi/settings/model-favorites', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'set', model: { provider: model.provider, modelId: model.id }, favorite }) });
                this.applyFavorites(data); this.syncMessage = '';
            } catch {
                this.syncMessage = t('常用模型未确认保存，请重新打开选择器核对；未自动重试。');
            } finally { this.favoriteBusy = false; if (this.dialog.open) this.render({ preserveScroll: true }); }
        }
        save(key, values) {
            try { localStorage.setItem(key, JSON.stringify(values)); }
            catch { this.status.textContent = t('浏览器无法保存模型偏好，本次页面内仍可使用。'); }
        }
        remember(model) {
            if (!model || !this.models.some(item => keyOf(item) === keyOf(model))) return;
            const key = keyOf(model);
            this.recent = [key, ...this.recent.filter(value => value !== key)].slice(0, 5);
            this.save(RECENT, this.recent);
        }
        update(models, current, disabled, placeholder) {
            const previous = this.current && keyOf(this.current);
            this.models = models;
            this.current = current;
            if (current && keyOf(current) !== previous) this.remember(current);
            const model = models.find(item => current && keyOf(item) === keyOf(current)) || current;
            this.label.textContent = model?.name || model?.id || placeholder || t(models.length ? '请选择已接入的模型' : '尚无可用模型');
            this.button.title = model ? `${model.name || model.id}\n${model.provider} / ${model.id}` : this.label.textContent;
            this.button.setAttribute('aria-label', `${t('选择模型')}：${this.label.textContent}`);
            this.setDisabled(disabled);
            if (models.length && !this.started) { this.started = true; void this.refreshFavorites(); }
            if (this.dialog.open) this.render();
        }
        setDisabled(disabled) {
            this.button.disabled = disabled;
            if (disabled) this.close();
        }
        position() {
            this.dialog.style.removeProperty('left');
            this.dialog.style.removeProperty('top');
            if (innerWidth <= 600) return;
            const rect = this.button.getBoundingClientRect();
            this.dialog.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - this.dialog.offsetWidth - 12))}px`;
            this.dialog.style.top = `${Math.max(12, Math.min(rect.bottom + 8, innerHeight - this.dialog.offsetHeight - 12))}px`;
        }
        open() {
            if (this.button.disabled || this.dialog.open) return;
            this.search.value = ''; this.all = false; this.limit = 60;
            this.render();
            this.dialog.showModal(); this.position();
            this.button.setAttribute('aria-expanded', 'true');
            // Avoid focusing any editable element on touch/mobile, including dialog's
            // initial autofocus. Desktop users retain immediate keyboard search.
            (innerWidth <= 900 || matchMedia('(pointer: coarse)').matches ? this.closeButton : this.search).focus({ preventScroll: true });
            this.migrationFailed = false;
            void this.refreshFavorites();
            clearInterval(this.syncTimer);
            this.syncTimer = setInterval(() => { if (!document.hidden) void this.refreshFavorites(); }, 5000);
        }
        close() { if (this.dialog.open) this.dialog.close(); }
        render({ preserveScroll = false } = {}) {
            const focus = document.activeElement;
            const focusKey = this.results.contains(focus) ? focus.dataset.key : null;
            const focusStar = focus?.classList.contains('pi-model-star');
            const scroll = this.results.scrollTop;
            this.results.replaceChildren();
            this.status.textContent = '';
            const byKey = new Map(this.models.map(model => [keyOf(model), model]));
            const seen = new Set();
            const addGroup = (label, models) => {
                const unique = models.filter(model => model && !seen.has(keyOf(model)) && seen.add(keyOf(model)));
                if (!unique.length) return;
                const section = node('section', 'pi-model-group');
                section.append(node('h3', '', label));
                for (const model of unique) section.append(this.row(model));
                this.results.append(section);
            };
            const query = this.search.value.trim().toLocaleLowerCase();
            if (query || this.all) {
                const words = query.split(/\s+/).filter(Boolean);
                const matches = this.models.filter(model => words.every(word => `${model.name || ''} ${model.id} ${model.provider}`.toLocaleLowerCase().includes(word)));
                const groups = new Map();
                for (const model of matches.slice(0, this.limit)) {
                    if (!groups.has(model.provider)) groups.set(model.provider, []);
                    groups.get(model.provider).push(model);
                }
                for (const [provider, models] of groups) addGroup(provider, models);
                this.status.textContent = matches.length ? t('显示 {0} / {1} 个模型', Math.min(this.limit, matches.length), matches.length) : t('没有匹配的模型，请尝试其他名称或供应商。');
                if (matches.length > this.limit) {
                    const more = node('button', 'pi-model-more', t('显示更多模型'));
                    more.type = 'button';
                    more.addEventListener('click', () => {
                        const oldCount = this.results.querySelectorAll('.pi-model-option').length;
                        this.limit += 60; this.render();
                        this.results.querySelectorAll('.pi-model-option')[oldCount]?.focus();
                    });
                    this.results.append(more);
                }
            } else {
                addGroup(t('常用模型'), this.favorites.map(key => byKey.get(key)));
                addGroup(t('当前模型'), this.current ? [byKey.get(keyOf(this.current))] : []);
                addGroup(t('最近使用'), this.recent.map(key => byKey.get(key)));
                if (!seen.size) this.results.append(node('p', 'pi-model-empty', t('搜索或查看全部模型，点击星标加入常用。')));
            }
            this.status.textContent = [this.status.textContent, this.syncMessage].filter(Boolean).join(' ');
            this.toggle.hidden = Boolean(query);
            this.toggle.textContent = this.all ? t('返回常用模型') : t('查看全部模型（{0}）', this.models.length);
            this.toggle.setAttribute('aria-expanded', String(this.all));
            this.results.scrollTop = focusKey || preserveScroll ? scroll : 0;
            if (focusKey) {
                const selector = focusStar ? '.pi-model-star' : '.pi-model-option';
                const replacement = [...this.results.querySelectorAll(selector)].find(button => button.dataset.key === focusKey);
                (replacement || this.closeButton).focus({ preventScroll: true });
            }
            if (this.dialog.open) this.position();
        }
        row(model) {
            const key = keyOf(model);
            const row = node('div', 'pi-model-row');
            const selected = this.current && keyOf(this.current) === key;
            row.dataset.current = String(Boolean(selected));
            const choose = node('button', 'pi-model-option');
            choose.type = 'button'; choose.dataset.key = key;
            choose.title = `${model.provider} / ${model.id}`;
            if (selected) choose.setAttribute('aria-current', 'true');
            const copy = node('div', 'pi-model-copy');
            copy.append(node('strong', '', model.name || model.id), node('small', '', `${model.provider} · ${model.id}`));
            const mark = node('b', 'pi-model-check', selected ? '✓' : '');
            mark.setAttribute('aria-hidden', 'true');
            choose.append(mark, copy);
            choose.addEventListener('click', () => {
                if (this.button.disabled) return;
                this.close();
                // The coordinator rechecks busy state and owns RPC/generation checks.
                this.onSelect(model);
            });
            const favorite = this.favorites.includes(key);
            const star = node('button', 'pi-model-star', favorite ? '★' : '☆');
            star.type = 'button'; star.dataset.key = key;
            star.setAttribute('aria-pressed', String(favorite));
            star.setAttribute('aria-label', t(favorite ? '取消常用：{0}（{1}）' : '加入常用：{0}（{1}）', model.name || model.id, model.provider));
            star.title = star.getAttribute('aria-label');
            star.disabled = !this.favoriteReady || this.favoriteBusy;
            star.addEventListener('click', () => void this.setFavorite(model, !favorite));
            row.append(choose, star);
            return row;
        }
    }
    window.PiModelPicker = PiModelPicker;
})();
