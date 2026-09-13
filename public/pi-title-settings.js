(() => {
    'use strict';
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    class TitleSettings {
        constructor({ apiFetch, saved }) {
            this.apiFetch = apiFetch; this.saved = saved;
            this.card = document.getElementById('settings-session-titles');
            this.toggle = document.getElementById('settings-auto-title');
            this.status = document.getElementById('settings-auto-title-status');
            this.controls = document.getElementById('settings-title-model-controls');
            this.readEpoch = 0; this.busy = false; this.dirty = false; this.current = null;
            this.models = []; this.providers = [];
            if (!this.card || !this.controls) return;
            this.provider = node('select'); this.provider.id = 'settings-title-provider';
            this.model = node('select'); this.model.id = 'settings-title-model';
            const providerLabel = node('label', t('供应商')), modelLabel = node('label', t('标题生成模型'));
            providerLabel.append(this.provider); modelLabel.append(this.model);
            this.saveButton = node('button', t('保存'), 'settings-primary-button'); this.saveButton.type = 'button';
            this.currentLabel = node('p'); this.currentLabel.id = 'settings-title-model-current';
            const help = node('p', t('专用模型用于所有线程的自动命名与重新生成；不可用时保留原标题，不会改用其他模型。') + ' '
                + t('每次最多引用 8,000 字符问答正文，不发送完整会话，也不加入主聊天上下文。'));
            help.className = 'settings-title-model-help';
            this.controls.append(providerLabel, modelLabel, this.saveButton, this.currentLabel, help);
            this.toggle.addEventListener('change', () => this.save({ enabled: this.toggle.checked }));
            this.provider.addEventListener('change', () => {
                this.draft = { provider: this.provider.value, modelId: this.available(this.provider.value)[0]?.id || '' };
                if (!this.provider.value) this.draft.modelId = '';
                this.dirty = true; this.render();
            });
            this.model.addEventListener('change', () => {
                this.draft = { provider: this.provider.value, modelId: this.model.value }; this.dirty = true; this.render();
            });
            this.saveButton.addEventListener('click', () => this.save({ ...this.draft }, true));
        }
        available(provider) { return this.models.filter(model => model.provider === provider && model.available && model.input?.includes('text') && !/:batch$/.test(model.id)); }
        setSnapshot(snapshot) {
            if (!this.controls) return;
            this.models = snapshot?.models || []; this.providers = snapshot?.providers || [];
            const settings = snapshot?.preferences?.sessionTitles;
            if (!this.busy && typeof settings?.enabled === 'boolean'
                && !(Number.isSafeInteger(this.current?.revision) && settings.revision < this.current.revision)) this.current = settings;
            this.render();
        }
        async refresh() {
            if (!this.current || this.busy) return;
            const epoch = ++this.readEpoch;
            try {
                const settings = await this.apiFetch('/api/pi/settings/session-titles');
                if (epoch !== this.readEpoch || this.busy) return;
                if (typeof settings?.enabled !== 'boolean') return;
                this.current = settings; this.saved(settings); this.render();
            } catch (error) { if (epoch === this.readEpoch) this.status.textContent = error.message; }
        }
        option(value, label) { const option = node('option', label); option.value = value; return option; }
        render() {
            if (!this.controls) return;
            this.card.hidden = !this.current;
            if (!this.current) return;
            this.toggle.checked = this.busy && this.pendingEnabled !== undefined ? this.pendingEnabled : this.current.enabled;
            this.toggle.disabled = this.busy;
            const supportsModels = typeof this.current.provider === 'string' && typeof this.current.modelId === 'string';
            this.controls.hidden = !supportsModels;
            if (!supportsModels) return; // The original title-only backend still supports its switch.
            if (!this.dirty) this.draft = { provider: this.current.provider, modelId: this.current.modelId };
            const providerIds = [...new Set(this.models.filter(model => model.available && model.input?.includes('text') && !/:batch$/.test(model.id)).map(model => model.provider))];
            this.provider.replaceChildren(this.option('', t('跟随当前线程')));
            for (const id of providerIds) this.provider.append(this.option(id, this.providers.find(provider => provider.id === id)?.name || id));
            if (this.draft.provider && !providerIds.includes(this.draft.provider)) this.provider.append(this.option(this.draft.provider, t('{0}（不可用）', this.draft.provider)));
            this.provider.value = this.draft.provider;
            this.model.replaceChildren();
            const models = this.draft.provider ? this.available(this.draft.provider) : [];
            if (!this.draft.provider) this.model.append(this.option('', t('跟随当前线程')));
            else {
                for (const model of models) this.model.append(this.option(model.id, model.name || model.id));
                if (!models.some(model => model.id === this.draft.modelId)) this.model.append(this.option(this.draft.modelId, t('{0}（不可用）', this.draft.modelId || this.draft.provider)));
            }
            this.model.value = this.draft.modelId;
            this.provider.disabled = this.busy; this.model.disabled = this.busy || !this.draft.provider;
            const changed = this.current.provider !== this.draft.provider || this.current.modelId !== this.draft.modelId;
            this.saveButton.disabled = this.busy || !changed || Boolean(this.draft.provider && !models.some(model => model.id === this.draft.modelId));
            const current = this.current.provider ? `${this.current.provider}/${this.current.modelId}` : t('跟随当前线程');
            this.currentLabel.textContent = t('当前标题模型：{0}', current);
        }
        async save(patch, modelChange = false) {
            if (this.busy || !this.current) return;
            this.busy = true; this.pendingEnabled = patch.enabled; this.readEpoch++;
            this.render(); this.status.textContent = t('正在保存…');
            const revision = Number.isSafeInteger(this.current.revision) ? { expectedRevision: this.current.revision } : {};
            try {
                const result = await this.apiFetch('/api/pi/settings/session-titles', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...patch, ...revision }) });
                this.current = result; this.saved(result);
                if (modelChange) this.dirty = false;
                this.status.textContent = t('自动标题设置已保存');
            } catch (error) {
                this.status.textContent = error.message;
                // Refresh the revision while keeping an unsaved model selection visible.
                this.busy = false; await this.refresh();
            } finally { this.busy = false; this.pendingEnabled = undefined; this.render(); }
        }
    }
    window.PiTitleSettings = { create: options => new TitleSettings(options) };
})();
