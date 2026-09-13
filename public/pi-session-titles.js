(() => {
    'use strict';
    const t = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    class PiSessionTitles {
        constructor({ apiFetch, saved }) {
            this.apiFetch = apiFetch; this.saved = saved; this.enabled = false; this.epoch = 0;
            this.dialog = node('dialog', undefined, 'pi-transfer-dialog');
            this.dialog.id = 'pi-title-dialog'; this.dialog.setAttribute('aria-labelledby', 'pi-title-heading');
            const header = node('header'), title = node('h2', t('重新生成标题'));
            title.id = 'pi-title-heading';
            const close = node('button', t('关闭'), 'pi-secondary-button'); close.type = 'button';
            close.onclick = () => this.close(); header.append(title, close);
            this.body = node('div', undefined, 'pi-transfer-body');
            this.status = node('p', '', 'pi-transfer-status'); this.status.setAttribute('role', 'status');
            this.footer = node('footer'); this.dialog.append(header, this.body, this.status, this.footer);
            this.dialog.addEventListener('close', () => { if (!this.dialog.open) this.epoch++; });
            document.body.append(this.dialog);
        }
        close() { this.epoch++; if (this.dialog.open) this.dialog.close(); }
        open(session, cwd) {
            if (!this.enabled || session.ephemeral) return;
            this.close();
            const epoch = ++this.epoch;
            const active = () => epoch === this.epoch && this.dialog.open;
            const url = `/api/pi/sessions/${encodeURIComponent(session.id)}/title`;
            this.body.replaceChildren(node('p', session.name || session.firstMessage || t('未命名会话')),
                node('p', t(this.modelSelection ? '按标题模型设置生成建议，会产生少量额外用量。可以编辑后保存，关闭窗口保留原名称。' : '使用当前线程的模型生成建议，会产生少量额外用量。可以编辑后保存，关闭窗口保留原名称。')));
            const label = node('label', t('会话名称')), input = node('input');
            input.id = 'pi-title-input'; input.maxLength = 120; input.disabled = true; input.autocomplete = 'off';
            label.append(input); this.body.append(label);
            const usage = node('p'); usage.id = 'pi-title-usage'; usage.hidden = true; usage.setAttribute('aria-live', 'polite');
            this.body.append(usage);
            const retry = node('button', t('重新生成标题'), 'pi-secondary-button'); retry.type = 'button';
            const save = node('button', t('保存'), 'pi-primary-button'); save.type = 'button'; save.disabled = true;
            this.footer.replaceChildren(retry, save);
            let suggestion = null, busy = false;
            const generate = async () => {
                if (busy) return;
                busy = true; retry.disabled = true; save.disabled = true; input.disabled = true;
                this.status.textContent = t('正在生成标题…');
                usage.hidden = true; usage.textContent = '';
                try {
                    const result = await this.apiFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd }) });
                    if (!active()) return;
                    suggestion = result; input.value = result.name; input.disabled = false; save.disabled = false;
                    if (result.model?.provider && result.model?.id) {
                        const count = key => Number.isSafeInteger(result.usage?.[key]) && result.usage[key] >= 0 ? String(result.usage[key]) : '—';
                        usage.append(node('span', t('本次模型：{0}', `${result.model.provider}/${result.model.id}`)), node('br'),
                            node('span', result.usage ? t('本次 Token：输入 {0} · 输出 {1} · 缓存读取 {2} · 缓存写入 {3}', count('input'), count('output'), count('cacheRead'), count('cacheWrite')) : t('本次用量未上报')));
                        usage.hidden = false;
                    }
                    this.status.textContent = t('建议已生成，保存后应用。'); input.focus(); input.select();
                } catch (error) { if (active()) this.status.textContent = error.message; }
                finally { if (active()) { busy = false; retry.disabled = false; input.disabled = !suggestion; } }
            };
            retry.onclick = generate;
            save.onclick = async () => {
                if (busy || !suggestion || !input.value.trim()) return;
                busy = true; save.disabled = true; retry.disabled = true; input.disabled = true;
                this.status.textContent = t('正在保存…');
                try {
                    const result = await this.apiFetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ cwd, nameRevision: suggestion.nameRevision, contextRevision: suggestion.contextRevision, name: input.value.trim() }) });
                    this.saved(session, cwd, result.name);
                    if (active()) this.close();
                } catch (error) {
                    if (active()) this.status.textContent = error.message;
                } finally {
                    // A submitted save is not replayed. Regenerate to obtain a current revision.
                    if (active()) { busy = false; retry.disabled = false; input.disabled = false; }
                }
            };
            this.dialog.showModal();
            void generate();
        }
    }
    window.PiSessionTitles = PiSessionTitles;
})();
