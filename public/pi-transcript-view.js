(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const MODE_KEY = 'pi.web.transcriptMode';
    const PROCESS_SELECTOR = '.pi-thinking-block, .pi-tool-row, .pi-bash-message';
    const TURN_GROUP_SELECTOR = '.pi-turn-group';
    // Everything before a turn's final reply counts as its process: intermediate
    // replies, tool rows and bash executions (standalone or inside process groups),
    // edit round cards and runtime notices.
    const TURN_MEMBER_SELECTOR = '.pi-message.assistant, .pi-message.custom, .pi-tool-row, .pi-bash-message, .pi-turn-edits, .pi-runtime-notice, .pi-event-notice, .pi-process-group';
    const PENDING_STOP_REASONS = new Set(['toolUse', 'pending']);

    class PiTranscriptView {
        constructor({ content, controls, scroll }) {
            Object.assign(this, { content, controls, scroll });
            this.groups = new Map();
            this.turnGroups = new Map();
            this.nextControlId = 0;
            this.frame = null;
            this.mode = 'reading';
            // The tail segment stays expanded while its turn is still running.
            this.tailActive = false;
            try {
                const stored = localStorage.getItem(MODE_KEY);
                if (stored === 'full' || stored === 'compact') this.mode = stored;
            } catch {}
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

        setTailActive(active) {
            active = Boolean(active);
            if (this.tailActive === active) return;
            this.tailActive = active;
            const position = this.scroll.capture();
            this.refresh();
            this.scroll.restore(position);
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
                if (article.matches('.pi-process-group') || article.matches(TURN_GROUP_SELECTOR)) return;
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
            this.refreshTurnGroups();
            this.content.dataset.transcriptMode = this.mode;
            for (const button of this.controls.querySelectorAll('[data-transcript-mode]')) {
                button.setAttribute('aria-pressed', String(button.dataset.transcriptMode === this.mode));
            }
            this.refreshVisibility();
        }

        nodeKey(node) {
            return node.dataset.messageKey || node.dataset.readingKey || `position:${[...this.content.children].indexOf(node)}`;
        }

        nodeTime(node) {
            const message = node._piUserMessage || node._piAssistantMessage || node._piCustomMessage;
            let value = message?.timestamp;
            if (value == null && node.dataset.messageKey) {
                try { value = JSON.parse(node.dataset.messageKey)[1]; } catch { value = null; }
            }
            const time = new Date(value).getTime();
            return Number.isFinite(time) ? time : null;
        }

        isFinalReplyNode(node) {
            if (!node.matches('.pi-message.assistant')) return false;
            const message = node._piAssistantMessage;
            // Live/streaming articles carry no persisted message yet; the tail
            // segment is skipped anyway while it runs.
            if (!message || PENDING_STOP_REASONS.has(message.stopReason)) return false;
            const body = node.querySelector(':scope > .pi-message-body');
            if (!body) return false;
            const blocks = [...body.children].filter(block => !block.matches('.pi-process-group'));
            if (blocks.some(block => block.matches('.pi-tool-row'))) return false;
            return blocks.some(block => !block.matches(PROCESS_SELECTOR) && (block.textContent.trim() || block.matches('img')));
        }

        formatDuration(milliseconds) {
            const total = Math.max(1, Math.round(milliseconds / 1000));
            const hours = Math.floor(total / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const seconds = total % 60;
            if (hours) return `${hours}h ${minutes}m`;
            if (minutes) return `${minutes}m ${seconds}s`;
            return `${seconds}s`;
        }

        refreshTurnGroups() {
            const segments = [];
            let current = null;
            for (const child of this.content.children) {
                if (child.matches(TURN_GROUP_SELECTOR)) continue;
                if (child.matches('.pi-message.user')) {
                    current = { user: child, nodes: [] };
                    segments.push(current);
                } else {
                    if (!current) {
                        current = { user: null, nodes: [] };
                        segments.push(current);
                    }
                    current.nodes.push(child);
                }
            }
            const active = new Map();
            for (const segment of segments) {
                const nodes = segment.nodes;
                if (!nodes.length) continue;
                if (segment === segments[segments.length - 1] && this.tailActive) continue;
                let finalIndex = -1;
                for (let i = nodes.length - 1; i >= 0; i--) {
                    if (this.isFinalReplyNode(nodes[i])) { finalIndex = i; break; }
                }
                // No final reply (pending tool confirmation, tool-only or bare
                // error tail): everything stays visible and actionable.
                if (finalIndex <= 0) continue;
                const members = nodes.slice(0, finalIndex).filter(node => node.matches(TURN_MEMBER_SELECTOR));
                if (!members.length) continue;
                const key = `turn:${this.nodeKey(members[0])}`;
                let group = this.turnGroups.get(key);
                if (!group || !group.element.isConnected) {
                    const element = document.createElement('details');
                    element.className = 'pi-turn-group';
                    element.dataset.detailKey = key;
                    element.innerHTML = '<summary><i class="fa-solid fa-chevron-right" aria-hidden="true"></i><span class="pi-turn-label"></span><span class="pi-turn-status"></span></summary>';
                    element.addEventListener('toggle', () => {
                        const position = this.scroll.capture();
                        this.refreshVisibility();
                        this.scroll.restore(position);
                    });
                    group = { element, members };
                }
                group.members = members;
                if (members[0].previousElementSibling !== group.element) members[0].before(group.element);
                for (const member of members) {
                    member.dataset.turnKey = key;
                    member.id ||= `pi-turn-item-${++this.nextControlId}`;
                }
                const start = this.nodeTime(segment.user || members[0]);
                const end = this.nodeTime(nodes[finalIndex]);
                const duration = start != null && end != null && end > start ? end - start : null;
                // Tool rows can be top-level nodes or nested inside an intermediate
                // assistant article (streamed tool calls); count each row once.
                const processNodes = nodes.slice(0, finalIndex);
                const tools = processNodes.reduce((count, node) => count
                    + (node.matches('.pi-tool-row, .pi-bash-message') ? 1 : 0)
                    + (node.querySelectorAll ? node.querySelectorAll('.pi-tool-row, .pi-bash-message').length : 0), 0);
                const label = [
                    duration != null ? translateUi("用时 {0}", this.formatDuration(duration)) : '',
                    tools ? translateUi("{0} 次工具调用", tools) : ''
                ].filter(Boolean).join(' · ') || translateUi("执行记录");
                const finalMessage = nodes[finalIndex]._piAssistantMessage || {};
                const failedTools = processNodes.reduce((count, node) => count
                    + (node.dataset.state === 'error' || node.matches('.pi-bash-message.error') ? 1 : 0)
                    + (node.querySelectorAll ? node.querySelectorAll('[data-state="error"], .pi-bash-message.error').length : 0), 0);
                const status = [
                    finalMessage.stopReason === 'aborted' ? translateUi("回复已停止") : '',
                    finalMessage.errorMessage || finalMessage.stopReason === 'error' ? translateUi("回复失败") : '',
                    failedTools ? translateUi("{0} 工具失败", failedTools) : ''
                ].filter(Boolean).join(' · ');
                const labelNode = group.element.querySelector('.pi-turn-label');
                const statusNode = group.element.querySelector('.pi-turn-status');
                if (labelNode.textContent !== label) labelNode.textContent = label;
                if (statusNode.textContent !== status) statusNode.textContent = status;
                group.element.querySelector('summary').setAttribute('aria-controls', members.map(member => member.id).join(' '));
                group.element.classList.toggle('has-error', Boolean(status));
                active.set(key, group);
            }
            for (const [key, group] of this.turnGroups) if (!active.has(key)) group.element.remove();
            this.turnGroups = active;
        }

        refreshVisibility() {
            const collapseProcess = this.mode !== 'full';
            const collapseTurns = this.mode === 'compact';
            for (const { element, members } of this.groups.values()) {
                element.hidden = !collapseProcess;
                element.querySelector('summary').setAttribute('aria-expanded', String(element.open));
                for (const member of members) member.hidden = collapseProcess && !element.open;
            }
            for (const article of this.content.querySelectorAll(':scope > .pi-message.assistant')) {
                const blocks = [...article.querySelector('.pi-message-body').children];
                const hasText = blocks.some(node => !node.matches(`${PROCESS_SELECTOR}, .pi-process-group`) && (node.textContent.trim() || node.matches('img')));
                article.classList.toggle('pi-process-only', collapseProcess && !hasText);
                article.hidden = collapseProcess && !blocks.some(node => !node.hidden && (node.textContent.trim() || node.matches('img')));
            }
            // Turn visibility runs last so a closed turn wins over per-article state.
            // A closed turn hides every member, but an open turn must not override
            // hiding that came from a closed process group.
            for (const { element, members } of this.turnGroups.values()) {
                element.hidden = !collapseTurns;
                element.querySelector('summary').setAttribute('aria-expanded', String(element.open));
                for (const member of members) member.hidden = member.hidden || (collapseTurns && !element.open);
            }
        }
    }

    window.PiTranscriptView = PiTranscriptView;
})();
