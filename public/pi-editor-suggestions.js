(() => {
    const node = (tag, text) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; return e; };
    class PiEditorSuggestions {
        constructor(host) {
            this.host = host; this.items = []; this.applied = new Set(); this.epoch = 0;
            this.root = node('details'); this.root.id = 'pi-editor-suggestions'; this.root.className = 'pi-editor-suggestions'; this.root.hidden = true;
            this.title = node('summary'); this.body = node('div'); this.root.append(this.title, this.body);
            document.getElementById('pi-input').closest('.pi-composer').before(this.root);
        }
        reset() { this.epoch++; this.autofilling = false; this.signature = ''; this.items = []; this.runtimeId = null; this.root.hidden = true; this.root.open = false; this.body.replaceChildren(); }
        apply(value) {
            if (!value || !Array.isArray(value.drafts)) return;
            const signature = JSON.stringify([value.runtimeId, value.drafts, value.draftOverflow]);
            if (signature === this.signature) return;
            this.signature = signature;
            this.runtimeId = value.runtimeId; this.items = value.drafts; this.overflow = value.draftOverflow;
            this.render();
            void this.autoFill();
        }
        async autoFill() {
            const draft = this.items[0], epoch = this.epoch;
            if (!draft || this.autofilling || !this.host.canAutofill?.()) return;
            const key = `${this.runtimeId}:${draft.id}`;
            if (this.applied.has(key) || !this.host.accept(draft.text, 'replace')) return;
            this.applied.add(key); if (this.applied.size > 512) this.applied.delete(this.applied.values().next().value); this.autofilling = true;
            try {
                if (this.runtimeId) { const value = await this.host.ack(this.runtimeId, draft.id); if (epoch === this.epoch) this.apply(value); }
                else { this.items = this.items.filter(d => d.id !== draft.id); this.render(); }
            } catch (e) { if (epoch === this.epoch) this.host.toast('建议已填入空草稿，但确认失败；可在建议中核对处理。', 'info'); }
            finally { if (epoch === this.epoch) this.autofilling = false; }
        }
        legacy(event) {
            if (!event.text) return;
            if (this.items.some(d => d.id === event.id)) return;
            if (event.text.length > 65536 || this.items.length >= 8) { this.overflow = true; return this.render(); }
            this.items.push({id: event.id, text: event.text}); this.render(); void this.autoFill();
        }
        render() {
            this.root.hidden = !this.items.length && !this.overflow;
            this.title.textContent = `扩展提供了 ${this.items.length} 条草稿建议`;
            this.body.replaceChildren();
            this.body.append(node('p', '建议仅保留在当前运行实例中，退出实例后不恢复。'));
            if (this.overflow) this.body.append(node('p', '部分扩展建议超过恢复限额，请处理已有建议后重新调用扩展。'));
            for (const draft of this.items) {
                const card = node('article'), pre = node('pre', draft.text), actions = node('div');
                const appliedKey = `${this.runtimeId}:${draft.id}`;
                for (const [label, mode] of [['追加到草稿', 'append'], ['替换文字', 'replace'], ['忽略', 'ignore']]) {
                    const button = node('button', label); button.type = 'button';
                    button.addEventListener('click', async () => {
                        if (!this.host.connected()) return;
                        const epoch = this.epoch;
                        if (mode !== 'ignore' && !this.applied.has(appliedKey)) {
                            if (mode === 'replace' && this.host.text() && !confirm('替换当前未发送的文字？已有附件会保留。')) return;
                            if (!this.host.accept(draft.text, mode)) return;
                            this.applied.add(appliedKey);
                            if (this.applied.size > 512) this.applied.delete(this.applied.values().next().value);
                        }
                        button.disabled = true;
                        try {
                            if (this.runtimeId) {
                                const value = await this.host.ack(this.runtimeId, draft.id);
                                if (epoch === this.epoch) this.apply(value);
                            } else { this.items = this.items.filter(d => d.id !== draft.id); this.render(); }
                        } catch (e) { if (epoch === this.epoch) { button.disabled = false; this.host.toast('建议已处理，但确认失败；本页不会重复追加。' + e.message, 'error'); } }
                    });
                    actions.append(button);
                }
                card.append(pre, actions); this.body.append(card);
            }
        }
    }
    window.PiEditorSuggestions = PiEditorSuggestions;
})();
