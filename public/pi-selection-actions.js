(() => {
    const t = globalThis.PiI18n?.t || (text => text);
    const labels = { assistant: '助手回复', user: '用户消息', 'side-assistant': '侧聊回复', 'side-user': '侧聊消息' };
    const serialize = quote => `> [Quoted text · ${quote.source}]\n${quote.text.split('\n').map(line => '> ' + line).join('\n')}\n\n`;
    function card(quote, remove) {
        const card = document.createElement('div'); card.className = 'pi-quote-card';
        const details = document.createElement('details');
        const summary = document.createElement('summary'); summary.textContent = t('引用') + ' · ' + t(labels[quote.source] || '消息正文');
        const preview = document.createElement('div'); preview.className = 'pi-quote-preview'; preview.textContent = quote.text;
        const full = document.createElement('div'); full.className = 'pi-quote-full'; full.textContent = quote.text;
        details.append(summary, full); card.append(details, preview);
        if (remove) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'pi-quote-remove';
            button.textContent = '×'; button.title = t('移除引用'); button.setAttribute('aria-label', button.title);
            button.addEventListener('click', remove); card.append(button);
        }
        return card;
    }
    function renderUser(element, text) {
        let rest = text || '', match;
        while ((match = rest.match(/^> \[Quoted text · (assistant|user|side-assistant|side-user)\]\n((?:> [^\n]*(?:\n|$))+)/))) {
            const body = match[2].replace(/\n$/, '').split('\n').map(line => line.slice(2)).join('\n');
            element.append(card({ source: match[1], text: body })); rest = rest.slice(match[0].length).replace(/^\n/, '');
        }
        if (rest) { const p = document.createElement('p'); p.style.whiteSpace = 'pre-wrap'; p.textContent = rest; element.append(p); }
    }
    class SelectionActions {
        constructor(host) {
            this.host = host;
            this.menu = document.createElement('div'); this.menu.className = 'pi-selection-menu'; this.menu.hidden = true;
            this.menu.setAttribute('role', 'menu'); this.menu.setAttribute('aria-label', t('选中文字操作'));
            for (const [action, label] of [['main', '加入主对话'], ['side', '在侧聊中提问'], ['tts', '朗读选区']]) {
                const button = document.createElement('button'); button.type = 'button'; button.dataset.selectionAction = action;
                button.setAttribute('role', 'menuitem'); button.textContent = t(label);
                button.addEventListener('click', () => void this.act(action)); this.menu.append(button);
            }
            document.body.append(this.menu);
            this.menu.addEventListener('pointerdown', event => event.preventDefault());
            document.addEventListener('selectionchange', () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.capture(), 180); });
            document.addEventListener('pointerup', () => { clearTimeout(this.timer); this.timer = setTimeout(() => this.capture(), 30); });
            document.addEventListener('contextmenu', event => {
                if (!event.target.closest('.pi-markdown')) return;
                // Keep touch browsers' native selection/copy menu available.
                if (matchMedia('(pointer: coarse)').matches) { this.capture(); return; }
                if (this.capture()) { event.preventDefault(); this.position(event.clientX, event.clientY); this.menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true }); }
            });
            document.addEventListener('pointerdown', event => { if (!this.menu.contains(event.target)) this.hide(); });
            document.addEventListener('keydown', event => {
                if (event.key === 'Escape') { this.hide(); clearTimeout(this.timer); }
                if (this.menu.hidden || !this.menu.contains(document.activeElement)) return;
                const buttons = [...this.menu.querySelectorAll('button:not(:disabled)')];
                if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                    event.preventDefault(); const index = buttons.indexOf(document.activeElement);
                    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + buttons.length) % buttons.length;
                    buttons[next]?.focus();
                } else if (event.key === 'Tab') this.hide();
            });
            window.addEventListener('resize', () => this.hide());
            document.addEventListener('scroll', event => { if (!this.menu.contains(event.target)) this.hide(); }, true);
        }
        hide() { this.menu.hidden = true; this.selected = null; CSS.highlights?.delete('pi-selection'); }
        capture() {
            if (this.menu.contains(document.activeElement) && this.selected) return true;
            if (document.activeElement?.matches('input, textarea, [contenteditable="true"]')) { this.hide(); return false; }
            const selection = getSelection();
            const parent = node => node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
            const start = parent(selection?.anchorNode)?.closest('.pi-message.user .pi-markdown, .pi-message.assistant .pi-markdown');
            const end = parent(selection?.focusNode)?.closest('.pi-markdown');
            if (!selection?.rangeCount || selection.isCollapsed || !start || start !== end || !start.closest('#pi-transcript, #pi-side-messages') || !this.host.context().connected) { this.hide(); return false; }
            const text = selection.toString().trim(); if (!text) { this.hide(); return false; }
            const range = selection.getRangeAt(0).cloneRange();
            const article = start.closest('.pi-message');
            const source = (start.closest('#pi-side-messages') ? 'side-' : '') + (article.classList.contains('assistant') ? 'assistant' : 'user');
            this.selected = { text, source, key: this.host.context().key, range };
            if (globalThis.Highlight && CSS.highlights) CSS.highlights.set('pi-selection', new Highlight(range));
            this.menu.querySelector('[data-selection-action="side"]').disabled = !this.host.sideEnabled();
            this.menu.querySelector('[data-selection-action="tts"]').disabled = !window.PiReplyTts?.enabled;
            this.menu.hidden = false;
            const rect = range.getBoundingClientRect(); this.position(rect.left, rect.bottom + 8);
            return true;
        }
        position(x, y) {
            const box = this.menu.getBoundingClientRect(), viewport = window.visualViewport;
            const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
            const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
            this.menu.style.left = Math.max(left + 8, Math.min(x, left + width - box.width - 8)) + 'px';
            this.menu.style.top = Math.max(top + 8, Math.min(y, top + height - box.height - 8)) + 'px';
        }
        async act(action) {
            const selected = this.selected;
            if (!selected || selected.key !== this.host.context().key || !this.host.context().connected) { this.hide(); return; }
            const quote = { text: selected.text, source: selected.source }; this.hide(); clearTimeout(this.timer);
            getSelection()?.removeAllRanges();
            try {
                if (action === 'main') this.host.addMain(quote);
                else if (action === 'side') await this.host.addSide(quote);
                else if (window.PiReplyTts.enabled) await window.PiReplyTts.speak({ text: quote.text, plain: true, key: JSON.stringify(['selection', selected.key, quote.source, quote.text]) });
            } catch (error) { this.host.toast(error.message, 'error'); }
        }
    }
    window.PiQuotes = { serialize, card, renderUser };
    window.PiSelectionActions = SelectionActions;
})();
