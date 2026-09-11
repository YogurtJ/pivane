(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const MODE_KEY = 'pi.web.transcriptMode';
    const PROCESS_SELECTOR = '.pi-thinking-block, .pi-tool-row, .pi-bash-message';

    class PiTranscriptView {
        constructor({ content, controls, scroll }) {
            Object.assign(this, { content, controls, scroll });
            this.groups = new Map();
            this.nextControlId = 0;
            this.frame = null;
            this.mode = 'reading';
            try { if (localStorage.getItem(MODE_KEY) === 'full') this.mode = 'full'; } catch {}
            controls.addEventListener('click', event => {
                const button = event.target.closest('[data-transcript-mode]');
                if (!button || button.dataset.transcriptMode === this.mode) return;
                const position = scroll.capture();
                this.mode = button.dataset.transcriptMode;
                try { localStorage.setItem(MODE_KEY, this.mode); } catch {}
                this.refresh();
                scroll.restore(position);
            });
            // Restore group visibility before the scroll controller measures its reading anchor.
            scroll.beforeRestore = () => this.refreshVisibility();
            this.refresh();
        }

        schedule() {
            if (this.frame !== null) return;
            this.frame = requestAnimationFrame(() => {
                this.frame = null;
                this.refresh();
                this.scroll.update();
            });
        }

        refresh() {
            if (this.frame !== null) cancelAnimationFrame(this.frame);
            this.frame = null;
            const runs = [];
            let run = [];
            const finish = () => { if (run.length) runs.push(run); run = []; };
            const visit = (node, key) => {
                if (node.matches('.pi-process-group')) return;
                if (!node.dataset.readingKey) node.dataset.readingKey = key;
                if (node.matches(PROCESS_SELECTOR)) run.push(node);
                else if (node.textContent.trim() || node.matches('img')) finish();
            };
            [...this.content.children].forEach((article, index) => {
                if (article.matches('.pi-process-group')) return;
                const key = article.dataset.messageKey || `position:${index}`;
                if (article.matches('.pi-message.assistant')) {
                    [...article.querySelector('.pi-message-body').children]
                        .filter(node => !node.matches('.pi-process-group'))
                        .forEach((node, block) => visit(node, `${key}:${block}`));
                } else if (article.matches(PROCESS_SELECTOR)) visit(article, key);
                else finish();
            });
            finish();
            const active = new Map();
            for (const members of runs) {
                const key = `process:${members[0].dataset.readingKey}`;
                let group = this.groups.get(key);
                if (!group || !group.element.isConnected) {
                    const element = document.createElement('details');
                    element.className = 'pi-process-group';
                    element.dataset.readingKey = key;
                    element.dataset.detailKey = key;
                    element.innerHTML = '<summary><i class="fa-solid fa-chevron-right" aria-hidden="true"></i><span class="pi-process-label"></span><span class="pi-process-status"></span></summary>';
                    element.addEventListener('toggle', () => {
                        const position = this.scroll.capture();
                        this.refreshVisibility();
                        this.scroll.restore(position);
                    });
                    group = { element, members };
                }
                group.members = members;
                if (members[0].previousElementSibling !== group.element) members[0].before(group.element);
                let tools = 0;
                let thinking = 0;
                let running = 0;
                let failed = 0;
                for (const member of members) {
                    member.dataset.processKey = key;
                    member.id ||= `pi-process-item-${++this.nextControlId}`;
                    if (member.matches('.pi-thinking-block')) thinking++;
                    else tools++;
                    if (member.dataset.state === 'running') running++;
                    if (member.dataset.state === 'error' || member.matches('.pi-bash-message.error')) failed++;
                }
                const label = [translateUi("执行记录"), tools ? translateUi("{0} 次工具调用", tools) : '', thinking ? translateUi("{0} 段思考", thinking) : ''].filter(Boolean).join(' · ');
                const status = [running ? translateUi("{0} 执行中", running) : '', failed ? translateUi("{0} 工具失败", failed) : ''].filter(Boolean).join(' · ');
                const labelNode = group.element.querySelector('.pi-process-label');
                const statusNode = group.element.querySelector('.pi-process-status');
                if (labelNode.textContent !== label) labelNode.textContent = label;
                if (statusNode.textContent !== status) statusNode.textContent = status;
                group.element.querySelector('summary').setAttribute('aria-controls', members.map(member => member.id).join(' '));
                group.element.classList.toggle('has-error', failed > 0);
                active.set(key, group);
            }
            for (const [key, group] of this.groups) if (!active.has(key)) group.element.remove();
            this.groups = active;
            this.content.dataset.transcriptMode = this.mode;
            for (const button of this.controls.querySelectorAll('[data-transcript-mode]')) {
                button.setAttribute('aria-pressed', String(button.dataset.transcriptMode === this.mode));
            }
            this.refreshVisibility();
        }

        refreshVisibility() {
            const reading = this.mode === 'reading';
            for (const { element, members } of this.groups.values()) {
                element.hidden = !reading;
                element.querySelector('summary').setAttribute('aria-expanded', String(element.open));
                for (const member of members) member.hidden = reading && !element.open;
            }
            for (const article of this.content.querySelectorAll(':scope > .pi-message.assistant')) {
                const blocks = [...article.querySelector('.pi-message-body').children];
                const hasText = blocks.some(node => !node.matches(`${PROCESS_SELECTOR}, .pi-process-group`) && (node.textContent.trim() || node.matches('img')));
                article.classList.toggle('pi-process-only', reading && !hasText);
                article.hidden = reading && !blocks.some(node => !node.hidden && (node.textContent.trim() || node.matches('img')));
            }
        }
    }

    window.PiTranscriptView = PiTranscriptView;
})();
