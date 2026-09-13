(() => {
    'use strict';
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    class AuxiliaryModels {
        constructor({ apiFetch, saved }) {
            this.apiFetch = apiFetch; this.saved = saved; this.root = document.getElementById('settings-auxiliary-models');
            this.current = null; this.models = []; this.providers = []; this.rows = new Map(); this.drafts = new Map();
            this.busy = false; this.readEpoch = 0;
            if (!this.root) return;
            const heading = node('h4', t('辅助模型')); heading.id = 'auxiliary-models-heading';
            this.root.setAttribute('aria-labelledby', heading.id);
            this.root.append(heading, node('p', t('按用途选择辅助模型。“自动”采用各用途的默认规则。保存不会运行任务。'), 'aux-models-intro'));
            this.list = node('div', undefined, 'aux-models-list'); this.root.append(this.list);
            const footer = node('div', undefined, 'aux-models-footer');
            this.reset = node('button', t('全部设为自动'), 'settings-secondary-button'); this.reset.type = 'button';
            this.saveButton = node('button', t('保存更改'), 'settings-primary-button'); this.saveButton.type = 'button';
            this.status = node('p', '', 'aux-models-status'); this.status.setAttribute('role', 'status');
            footer.append(this.reset, this.saveButton); this.root.append(footer, this.status);
            this.reset.onclick = () => {
                for (const purpose of this.current.purposes) this.change(purpose, { ...this.value(purpose), provider: '', modelId: '' });
                this.render();
            };
            this.saveButton.onclick = () => this.save();
        }
        acceptSnapshot(snapshot) {
            if (!this.root) return false;
            if (snapshot?.auxiliaryModels?.version !== 1) {
                this.readEpoch++; this.root.hidden = true;
                document.getElementById('settings-media-agent-form').hidden = false;
                return false;
            }
            this.models = snapshot.models || []; this.providers = snapshot.providers || [];
            if (!this.current) this.current = snapshot.auxiliaryModels;
            this.root.hidden = false;
            document.getElementById('settings-session-titles').hidden = true;
            document.getElementById('settings-media-agent-form').hidden = true;
            this.render();
            return true;
        }
        async refresh() {
            if (!this.current || this.busy) return;
            const epoch = ++this.readEpoch;
            try {
                const data = await this.apiFetch('/api/pi/settings/auxiliary-models');
                if (epoch !== this.readEpoch || this.busy || data?.version !== 1) return;
                this.current = data; this.saved(data); this.render();
            } catch (error) { if (epoch === this.readEpoch) this.status.textContent = error.message; }
        }
        available(provider) { return this.models.filter(model => model.provider === provider && model.available && model.input?.includes('text') && !/:batch$/.test(model.id)); }
        value(purpose) {
            return this.drafts.get(purpose.id) || { provider: purpose.settings.provider, modelId: purpose.settings.modelId,
                ...(purpose.enabledLabel ? { enabled: purpose.settings.enabled } : {}) };
        }
        patch(purpose, value = this.value(purpose)) {
            const patch = {};
            if (purpose.settings.provider !== value.provider || purpose.settings.modelId !== value.modelId) Object.assign(patch, { provider: value.provider, modelId: value.modelId });
            if (purpose.enabledLabel && value.enabled !== purpose.settings.enabled) patch.enabled = value.enabled;
            return patch;
        }
        change(purpose, value) {
            if (Object.keys(this.patch(purpose, value)).length) this.drafts.set(purpose.id, value);
            else this.drafts.delete(purpose.id);
            this.status.textContent = this.drafts.size ? t('有未保存的修改，保存后用于后续任务。') : '';
        }
        option(value, text) { const option = node('option', text); option.value = value; return option; }
        createRow(purpose) {
            const row = node('article', undefined, 'aux-model-row'); row.dataset.purpose = purpose.id;
            const main = node('div', undefined, 'aux-model-main'), copy = node('div', undefined, 'aux-model-copy');
            const label = node('strong', t(purpose.label)), description = node('p', t(purpose.description)), badge = node('small');
            copy.append(label, description, badge);
            const providerLabel = node('label', t('供应商'), 'aux-model-field'), modelLabel = node('label', t('模型'), 'aux-model-field');
            const provider = node('select'), model = node('select');
            provider.setAttribute('aria-label', t('{0} · 供应商', t(purpose.label))); model.setAttribute('aria-label', t('{0} · 模型', t(purpose.label)));
            providerLabel.append(provider); modelLabel.append(model);
            const gear = node('button', undefined, 'aux-model-options'); gear.type = 'button';
            gear.setAttribute('aria-label', t('配置{0}', t(purpose.label))); gear.title = t('配置{0}', t(purpose.label));
            const icon = node('i', undefined, 'fa-solid fa-gear'); icon.setAttribute('aria-hidden', 'true'); gear.append(icon);
            const details = node('div', undefined, 'aux-model-details'); details.hidden = true;
            details.id = `aux-model-details-${this.rows.size}`; gear.setAttribute('aria-controls', details.id); gear.setAttribute('aria-expanded', 'false');
            const current = node('p'); details.append(current, node('p', t(purpose.help)), node('p', t('指定模型不可用时不会自动换成其他模型。')));
            let enabled;
            if (purpose.enabledLabel) {
                const toggle = node('label', t(purpose.enabledLabel), 'settings-toggle-line');
                enabled = node('input'); enabled.type = 'checkbox'; toggle.append(enabled); details.prepend(toggle);
                enabled.onchange = () => { this.change(purpose, { ...this.value(purpose), enabled: enabled.checked }); this.render(); };
            }
            gear.onclick = () => { details.hidden = !details.hidden; gear.setAttribute('aria-expanded', String(!details.hidden)); };
            provider.onchange = () => {
                this.change(purpose, { ...this.value(purpose), provider: provider.value, modelId: provider.value ? this.available(provider.value)[0]?.id || '' : '' }); this.render();
            };
            model.onchange = () => { this.change(purpose, { ...this.value(purpose), modelId: model.value }); this.render(); };
            main.append(copy, providerLabel, modelLabel, gear); row.append(main, details); this.list.append(row);
            return { row, provider, model, enabled, current, badge, purpose };
        }
        render() {
            if (!this.current) return;
            let invalid = false;
            const providerIds = [...new Set(this.models.filter(model => model.available && model.input?.includes('text') && !/:batch$/.test(model.id)).map(model => model.provider))];
            for (const purpose of this.current.purposes) {
                let row = this.rows.get(purpose.id);
                if (!row) { row = this.createRow(purpose); this.rows.set(purpose.id, row); }
                // Handlers retain this descriptor object; update its current settings after a save/read.
                Object.assign(row.purpose, purpose);
                const value = this.value(purpose), models = value.provider ? this.available(value.provider) : [];
                row.provider.replaceChildren(this.option('', t(purpose.automaticLabel)));
                for (const id of providerIds) row.provider.append(this.option(id, this.providers.find(provider => provider.id === id)?.name || id));
                if (value.provider && !providerIds.includes(value.provider)) row.provider.append(this.option(value.provider, t('{0}（不可用）', value.provider)));
                row.provider.value = value.provider;
                row.model.replaceChildren();
                if (!value.provider) row.model.append(this.option('', t(purpose.automaticLabel)));
                else {
                    for (const model of models) row.model.append(this.option(model.id, model.name || model.id));
                    if (!models.some(model => model.id === value.modelId)) row.model.append(this.option(value.modelId, t('{0}（不可用）', value.modelId || value.provider)));
                }
                row.model.value = value.modelId;
                row.provider.disabled = this.busy; row.model.disabled = this.busy || !value.provider;
                if (row.enabled) { row.enabled.checked = value.enabled; row.enabled.disabled = this.busy; }
                row.current.textContent = t('已保存：{0}', purpose.settings.provider ? `${purpose.settings.provider}/${purpose.settings.modelId}` : t(purpose.automaticLabel));
                row.badge.textContent = purpose.enabledLabel && value.enabled === false ? t('自动命名已关闭，仍可手动生成') : '';
                const patch = this.patch(purpose, value);
                if (patch.provider && !models.some(model => model.id === patch.modelId)) invalid = true;
            }
            this.saveButton.disabled = this.busy || !this.drafts.size || invalid;
            this.reset.disabled = this.busy || this.current.purposes.every(purpose => !this.value(purpose).provider);
        }
        async save() {
            if (this.busy || !this.drafts.size) return;
            const changes = {};
            for (const purpose of this.current.purposes) {
                const patch = this.patch(purpose);
                if (Object.keys(patch).length) changes[purpose.id] = patch;
            }
            if (!Object.keys(changes).length) { this.drafts.clear(); this.render(); return; }
            this.busy = true; this.readEpoch++; this.render(); this.status.textContent = t('正在保存…');
            try {
                const data = await this.apiFetch('/api/pi/settings/auxiliary-models', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ expectedRevision: this.current.revision, changes }) });
                this.current = data; this.drafts.clear(); this.saved(data);
                this.status.textContent = t('辅助模型设置已保存');
            } catch (error) {
                this.status.textContent = error.message;
                this.busy = false; await this.refresh();
            } finally { this.busy = false; this.render(); }
        }
    }
    window.PiAuxiliaryModels = { create: options => new AuxiliaryModels(options) };
})();
