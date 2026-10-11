(() => {
    // Read-only view of the turns Pi no longer sends to the model: everything on the current
    // branch before the latest compaction's kept boundary. It sits above the live transcript,
    // loads in small segments on demand and never writes, caches or resends anything; the
    // model context is still built by Pi from the session file alone.
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const SEGMENT = 12, MAX_LOADED = 120, INDEX_PAGES = 100, STEP_ICON = { tool: 'fa-wrench', bash: 'fa-terminal', text: 'fa-comment-dots' };
    const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
    const icon = name => { const i = el('i', `fa-solid ${name}`); i.setAttribute('aria-hidden', 'true'); return i; };
    const asked = item => item.kind !== 'summary';

    function duration(start, end) {
        const ms = new Date(end).getTime() - new Date(start).getTime();
        if (!Number.isFinite(ms) || ms < 1000) return '';
        const s = Math.round(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
        return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
    }

    class PiTranscriptArchive {
        constructor({ scroller, content, container, track, request, context, render, scroll, openEntry, toast, onChange }) {
            Object.assign(this, { scroller, content, container, request, context, render, scroll, openEntry, toast, onChange });
            this.enabled = false; this.key = null; this.identity = null; this.generation = null; this.sequence = 0;
            this.items = []; this.slots = []; this.entries = new Map(); this.revision = null;
            this.state = 'idle'; this.armed = false; this.queue = Promise.resolve(); this.busy = null; this.failed = null;
            this.visibleGaps = new Set();
            container.hidden = true;
            container.setAttribute('aria-label', translateUi("压缩前的对话"));
            this.head = el('div', 'pi-archive-head');
            this.observer = new IntersectionObserver(changes => {
                for (const change of changes) {
                    if (change.isIntersecting) this.visibleGaps.add(change.target); else this.visibleGaps.delete(change.target);
                }
                this.autoload();
            }, { root: scroller, rootMargin: '900px 0px 600px 0px' });
            // Older segments load only after the reader scrolls up themselves, so opening a
            // thread costs nothing beyond the small index.
            const arm = () => { if (!this.armed && this.items.length) { this.armed = true; this.autoload(); } };
            scroller.addEventListener('wheel', event => { if (event.deltaY < 0) arm(); }, { passive: true });
            let touchY = null;
            scroller.addEventListener('touchstart', event => { touchY = event.touches[0]?.clientY ?? null; }, { passive: true });
            scroller.addEventListener('touchmove', event => {
                const y = event.touches[0]?.clientY; if (touchY != null && y > touchY + 4) arm(); touchY = y;
            }, { passive: true });
            scroller.addEventListener('keydown', event => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) arm(); });
            track?.addEventListener('pointerdown', arm);
            container.addEventListener('click', event => this.click(event));
            container.addEventListener('toggle', event => {
                const details = event.target;
                if (details.matches?.('.pi-archive-process') && details.open && !details.dataset.loaded) void this.loadSteps(details);
            }, true);
        }

        // ---- capability, thread identity and index -----------------------------------------

        setEnabled(enabled) { this.enabled = Boolean(enabled); this.sync(); }

        readable() { const c = this.context(); return this.enabled && c.connected && c.session && !c.session.ephemeral; }

        live(key, generation, sequence) { const c = this.context(); return c.key === key && c.generation === generation && sequence === this.sequence; }

        // The archive belongs to the compaction summary shown at the top of the live transcript.
        sync() {
            const c = this.context();
            const notice = this.enabled && c.session && !c.session.ephemeral ? this.content.querySelector(':scope > .pi-summary-notice.compactionSummary') : null;
            const identity = notice ? `${c.key}|${notice.dataset.messageKey || ''}` : null;
            if (c.key !== this.key || identity !== this.identity) {
                this.reset(); this.key = c.key; this.identity = identity; this.generation = c.generation;
                if (identity && this.readable()) void this.loadIndex();
                return;
            }
            if (c.generation !== this.generation) {
                // Reconnected: drop in-flight work and re-validate; identical revisions keep the DOM.
                this.generation = c.generation; this.sequence++; this.busy = null; this.queue = Promise.resolve();
                if (identity && this.readable()) void this.loadIndex(true);
                else this.paintGaps();
            } else if (identity && this.readable() && this.state === 'idle') void this.loadIndex();
        }

        reset() {
            this.sequence++; this.queue = Promise.resolve(); this.busy = null; this.failed = null;
            this.items = []; this.slots = []; this.entries.clear(); this.revision = null; this.state = 'idle'; this.armed = false;
            this.observer.disconnect(); this.visibleGaps.clear();
            const had = this.container.childElementCount > 0;
            this.container.replaceChildren(); this.container.hidden = true;
            if (had) this.onChange?.();
        }

        async loadIndex(keep = false) {
            const { key, generation } = this.context(), sequence = ++this.sequence;
            this.busy = null; this.queue = Promise.resolve();
            this.state = 'loading'; if (!keep) this.paintHead();
            try {
                const items = []; let offset = 0, revision = null, more = true, pages = 0;
                while (more) {
                    if (pages++ >= INDEX_PAGES) throw new Error(translateUi("压缩前的记录过多，请在历史中搜索查看"));
                    const data = await this.request('get_history_archive', { view: 'index', offset, ...(offset ? { revision } : {}) });
                    if (!this.live(key, generation, sequence)) return;
                    revision = data.revision; items.push(...data.turns);
                    offset = data.offset + data.turns.length; more = Boolean(data.hasMore) && data.turns.length > 0;
                }
                if (keep && revision === this.revision && items.length === this.items.length && this.container.contains(this.head)) {
                    this.items = items; this.state = 'ready'; this.paintHead(); this.paintGaps(); return;
                }
                this.adopt(revision, items);
            } catch (error) {
                if (!this.live(key, generation, sequence)) return;
                this.state = 'error'; this.error = translateUi(error.message);
                if (!keep && this.items.length) {
                    // Sections from a replaced revision must not stay readable or loadable.
                    this.observer.disconnect(); this.visibleGaps.clear(); this.failed = null;
                    this.items = []; this.slots = []; this.entries.clear(); this.revision = null;
                    this.scroll.preserve(() => { this.container.replaceChildren(this.head); this.fillHead(); });
                    this.onChange?.();
                } else this.paintHead();
            }
        }

        adopt(revision, items) {
            const had = this.container.childElementCount > 0;
            this.observer.disconnect(); this.visibleGaps.clear(); this.failed = null;
            this.revision = revision; this.items = items; this.slots = new Array(items.length).fill(null);
            this.entries.clear();
            for (const item of items) {
                if (item.entryId) this.entries.set(item.entryId, { index: item.index, part: 'head' });
                if (item.reply?.entryId) this.entries.set(item.reply.entryId, { index: item.index, part: 'reply' });
            }
            this.state = 'ready';
            this.scroll.preserve(() => {
                this.container.replaceChildren(this.head);
                this.fillHead(); this.layout();
                this.container.hidden = !items.length;
            });
            if (had || items.length) this.onChange?.();
        }

        paintHead() { this.scroll.preserve(() => this.fillHead()); }

        fillHead() {
            const head = this.head; head.replaceChildren();
            if (!head.isConnected) { this.container.replaceChildren(head); this.container.hidden = false; }
            if (this.state === 'loading') {
                head.append(el('span', 'pi-spinner'), el('span', 'pi-archive-head-text', translateUi("正在读取压缩前的记录…")));
            } else if (this.state === 'error') {
                head.append(icon('fa-circle-exclamation'), el('span', 'pi-archive-head-text', this.error || translateUi("压缩前的记录暂时无法读取")));
                const retry = el('button', 'pi-archive-link', translateUi("重试")); retry.type = 'button'; retry.dataset.archiveAction = 'index';
                head.append(retry);
            } else {
                const count = this.items.filter(asked).length;
                const text = el('span', 'pi-archive-head-text');
                text.append(icon('fa-box-archive'), document.createTextNode(count ? translateUi("压缩前的 {0} 个问题", count) : translateUi("压缩前的记录")));
                head.append(text, el('span', 'pi-archive-head-note', translateUi("仅供回看，模型不会再读取这些原文")));
            }
        }

        // ---- segments --------------------------------------------------------------------

        // Order the container as: head, then loaded sections and one placeholder per unloaded run.
        layout() {
            const wanted = [this.head];
            for (let i = 0; i < this.slots.length;) {
                if (this.slots[i]) { wanted.push(this.slots[i]); i++; continue; }
                let end = i; while (end < this.slots.length && !this.slots[end]) end++;
                wanted.push(this.gap(i, end)); i = end;
            }
            let cursor = this.container.firstChild;
            for (const node of wanted) {
                if (node === cursor) { cursor = cursor.nextSibling; continue; }
                this.container.insertBefore(node, cursor);
            }
            while (cursor) { const next = cursor.nextSibling; cursor.remove(); cursor = next; }
            this.observer.disconnect(); this.visibleGaps.clear();
            for (const gap of this.container.querySelectorAll(':scope > .pi-archive-gap')) this.observer.observe(gap);
        }

        gap(start, end) {
            const node = el('div', 'pi-archive-gap'); node.dataset.start = String(start); node.dataset.end = String(end);
            this.paintGap(node);
            return node;
        }

        paintGap(node) {
            const start = Number(node.dataset.start), end = Number(node.dataset.end);
            const count = this.items.slice(start, end).filter(asked).length;
            const loading = this.busy && this.busy.start < end && this.busy.end > start;
            const failed = this.failed && this.failed.start < end && this.failed.end > start ? this.failed : null;
            node.replaceChildren();
            const button = el('button', 'pi-archive-load'); button.type = 'button'; button.dataset.archiveAction = 'load';
            button.disabled = Boolean(loading) || !this.readable();
            // The top run holds the oldest turns; any other run sits between loaded segments.
            const label = loading ? translateUi("正在加载…") : failed ? translateUi("重新加载")
                : start === 0 ? (count ? translateUi("显示更早的 {0} 个问题", count) : translateUi("显示更早的记录"))
                    : (count ? translateUi("显示中间的 {0} 个问题", count) : translateUi("显示中间的记录"));
            button.append(loading ? el('span', 'pi-spinner') : icon(failed ? 'fa-rotate-right' : start === 0 ? 'fa-angles-up' : 'fa-angles-down'), el('span', null, label));
            node.append(button);
            if (failed) node.append(el('p', 'pi-archive-error', failed.message));
        }

        paintGaps() { for (const gap of this.container.querySelectorAll(':scope > .pi-archive-gap')) this.paintGap(gap); }

        // Which part of an unloaded run to load: the end when the run is above the reader
        // (scrolling up into it), the start when it lies below (reading on downward).
        portion(gap) {
            const start = Number(gap.dataset.start), end = Number(gap.dataset.end);
            const view = this.scroller.getBoundingClientRect(), box = gap.getBoundingClientRect();
            return box.top >= (view.top + view.bottom) / 2 && start > 0 ? [start, Math.min(end, start + SEGMENT)] : [Math.max(start, end - SEGMENT), end];
        }

        // The unloaded run containing one index.
        run(index) {
            if (index < 0 || index >= this.slots.length || this.slots[index]) return null;
            let start = index, end = index + 1;
            while (start > 0 && !this.slots[start - 1]) start--;
            while (end < this.slots.length && !this.slots[end]) end++;
            return { start, end };
        }

        // Load one segment, serialised so the archive holds at most one history request.
        load(start, end) {
            const { key, generation } = this.context(), sequence = this.sequence;
            const task = this.queue.then(() => this.live(key, generation, sequence) ? this.fetch(start, end) : false);
            this.queue = task.catch(() => {});
            return task;
        }

        async fetch(start, end) {
            if (!this.readable() || this.state !== 'ready') return false;
            start = Math.max(0, start); end = Math.min(this.slots.length, end);
            while (start < end && this.slots[end - 1]) end--;
            while (start < end && this.slots[start]) start++;
            if (start >= end) return true;
            const { key, generation } = this.context(), sequence = this.sequence;
            this.busy = { start, end }; this.failed = null; this.paintGaps();
            try {
                const data = await this.request('get_history_archive', { view: 'turns', start, end, revision: this.revision });
                if (!this.live(key, generation, sequence)) return false;
                this.busy = null;
                // An answer that adds nothing must not let autoload ask again forever.
                if (!this.insert(data?.turns || [])) { this.failed = { start, end, message: translateUi("压缩前的记录暂时无法读取") }; this.paintGaps(); return false; }
                return true;
            } catch (error) {
                if (!this.live(key, generation, sequence)) return false;
                this.busy = null;
                if (error.errorCode === 'HISTORY_STALE') { void this.loadIndex(); return false; }
                this.failed = { start, end, message: translateUi(error.message) }; this.paintGaps();
                return false;
            }
        }

        insert(turns) {
            const added = [];
            this.scroll.preserve(() => {
                for (const turn of turns) {
                    if (!Number.isInteger(turn.index) || turn.index < 0 || turn.index >= this.slots.length || this.slots[turn.index]) continue;
                    this.slots[turn.index] = this.section(turn); added.push(turn.index);
                }
                this.trim(added);
                this.layout();
            });
            this.onChange?.();
            return added.length > 0;
        }

        // Keep the page light: beyond the cap, drop the loaded turns farthest from the ones just
        // loaded, never anything on screen or holding focus.
        trim(added) {
            const loaded = this.slots.map((node, index) => node ? index : -1).filter(index => index >= 0);
            if (loaded.length <= MAX_LOADED || !added.length) return;
            const low = Math.min(...added), high = Math.max(...added), view = this.scroller.getBoundingClientRect();
            const keep = node => node.contains(document.activeElement) || (() => { const r = node.getBoundingClientRect(); return r.bottom > view.top - 200 && r.top < view.bottom + 200; })();
            const order = loaded.filter(index => index < low || index > high)
                .sort((a, b) => Math.max(low - b, b - high) - Math.max(low - a, a - high));
            let count = loaded.length;
            for (const index of order) {
                if (count <= MAX_LOADED - SEGMENT) break;
                if (keep(this.slots[index])) continue;
                this.slots[index] = null; count--;
            }
        }

        autoload() {
            if (this.state !== 'ready' || !this.armed || this.busy || this.failed || !this.visibleGaps.size || !this.readable()) return;
            // The placeholder nearest the reader (the lowest one in view) loads from its bottom.
            const view = this.scroller.getBoundingClientRect(), middle = (view.top + view.bottom) / 2;
            const distance = node => { const box = node.getBoundingClientRect(); return box.bottom < middle ? middle - box.bottom : box.top > middle ? box.top - middle : 0; };
            const gap = [...this.visibleGaps].filter(node => node.isConnected).sort((a, b) => distance(a) - distance(b))[0];
            if (!gap) return;
            const [start, end] = this.portion(gap);
            // Continue only after progress; a refusal waits for the reader or a fresh index.
            void this.load(start, end).then(loaded => { if (loaded) requestAnimationFrame(() => this.autoload()); });
        }

        // ---- rendering ---------------------------------------------------------------------

        section(turn) {
            const section = el('section', `pi-archive-turn is-${turn.kind}`); section.dataset.archiveIndex = String(turn.index);
            if (turn.kind === 'summary') {
                const summary = window.PiAgentCards?.summary(turn.summaryType === 'branch_summary' ? 'branchSummary' : 'compactionSummary', { summary: turn.text, tokensBefore: turn.tokensBefore });
                if (summary) { summary.classList.add('pi-archive-head-node'); section.append(summary); }
                if (turn.textTruncated) section.append(this.note([], turn.entryId));
                return section;
            }
            const head = turn.kind === 'user'
                ? this.render({ role: 'user', content: [{ type: 'text', text: turn.text || '' }], timestamp: turn.timestamp })
                : this.agent(turn);
            if (head) { head.classList.add('pi-archive-head-node'); section.append(head); }
            if (turn.images || turn.textTruncated) section.append(this.note(turn.images ? [translateUi("原问题含 {0} 张图片，此处不显示", turn.images)] : [], turn.textTruncated ? turn.entryId : null));
            const process = turn.process || {};
            if (process.steps > 0) section.append(this.process(turn));
            if (turn.reply) {
                const { reply } = turn;
                const node = this.render({ role: 'assistant', content: [{ type: 'text', text: reply.text || '' }], timestamp: reply.timestamp, model: reply.model,
                    stopReason: reply.stopReason, errorMessage: reply.errorMessage });
                if (node) { node.classList.add('pi-archive-reply'); section.append(node); }
                if (reply.truncated) section.append(this.note([], reply.entryId));
            } else if (turn.continues) {
                const note = el('p', 'pi-archive-continues'); note.append(icon('fa-arrow-down'), document.createTextNode(translateUi("这一轮后续的执行和回复在下方的当前上下文中")));
                section.append(note);
            } else section.append(el('p', 'pi-archive-continues', translateUi("这一轮没有文字回复")));
            return section;
        }

        // Scheduled tasks, Agent handoffs and background notices that started a turn.
        agent(turn) {
            const article = el('article', 'pi-message custom pi-archive-agent');
            article._piCustomMessage = { role: 'custom', customType: turn.customType, content: turn.text || '', timestamp: turn.timestamp };
            const header = el('header'); header.append(el('strong', null, translateUi("Agent 消息")));
            if (turn.customType) header.append(el('span', null, turn.customType));
            const body = el('div', 'pi-message-body'), text = el('div', 'pi-markdown pi-archive-agent-text', turn.text || translateUi("无文字正文"));
            body.append(text); article.append(header, body);
            return article;
        }

        note(lines, entryId) {
            const note = el('p', 'pi-archive-note');
            for (const line of lines) note.append(el('span', null, line));
            if (entryId) {
                const open = el('button', 'pi-archive-link', translateUi("内容较长，在历史中查看全文")); open.type = 'button';
                open.dataset.archiveAction = 'entry'; open.dataset.entryId = entryId; note.append(open);
            }
            return note;
        }

        process(turn) {
            const { steps, tools, errors, startedAt, endedAt } = turn.process;
            const details = el('details', 'pi-archive-process'); details.dataset.index = String(turn.index);
            const summary = el('summary');
            const parts = [tools ? translateUi("{0} 次工具调用", tools) : translateUi("{0} 个执行步骤", steps)];
            const time = duration(startedAt, endedAt); if (time) parts.unshift(translateUi("用时 {0}", time));
            if (errors) parts.push(translateUi("{0} 个错误", errors));
            summary.append(icon('fa-chevron-right'), el('span', null, parts.join(' · ')));
            details.append(summary, el('div', 'pi-archive-steps'));
            return details;
        }

        async loadSteps(details, offset = 0) {
            const list = details.querySelector('.pi-archive-steps'), index = Number(details.dataset.index);
            if (!this.readable()) return;
            const { key, generation } = this.context(), sequence = this.sequence;
            details.dataset.loaded = 'loading';
            list.querySelector('.pi-archive-more')?.remove(); list.querySelector('.pi-archive-error')?.remove();
            const waiting = el('p', 'pi-archive-steps-state'); waiting.append(el('span', 'pi-spinner'), document.createTextNode(translateUi("正在读取执行过程…"))); list.append(waiting);
            try {
                const data = await this.request('get_history_archive', { view: 'process', index, offset, revision: this.revision });
                if (!this.live(key, generation, sequence)) return;
                waiting.remove();
                for (const step of data.steps || []) list.append(this.step(step));
                if (data.hasMore) {
                    const more = el('button', 'pi-archive-link pi-archive-more', translateUi("显示更多步骤（共 {0} 步）", data.total)); more.type = 'button';
                    more.dataset.archiveAction = 'steps'; more.dataset.offset = String(data.offset + (data.steps || []).length); list.append(more);
                }
                details.dataset.loaded = 'done';
            } catch (error) {
                if (!this.live(key, generation, sequence)) return;
                waiting.remove(); delete details.dataset.loaded;
                if (error.errorCode === 'HISTORY_STALE') { void this.loadIndex(); return; }
                const failed = el('p', 'pi-archive-error', translateUi(error.message));
                const retry = el('button', 'pi-archive-link', translateUi("重试")); retry.type = 'button'; retry.dataset.archiveAction = 'steps'; retry.dataset.offset = String(offset);
                failed.append(retry); list.append(failed);
            }
        }

        step(step) {
            const button = el('button', `pi-archive-step is-${step.kind}${step.isError ? ' is-error' : ''}`); button.type = 'button';
            button.dataset.archiveAction = 'entry'; button.dataset.entryId = step.resultEntryId || step.entryId; button.dataset.view = 'record';
            button.append(icon(step.isError ? 'fa-circle-exclamation' : STEP_ICON[step.kind] || 'fa-wrench'));
            if (step.name) button.append(el('strong', null, step.name));
            button.append(el('span', null, step.label || ''));
            button.title = translateUi("在历史中查看这一步");
            return button;
        }

        click(event) {
            const target = event.target.closest('[data-archive-action]'); if (!target || !this.container.contains(target)) return;
            const action = target.dataset.archiveAction;
            if (action === 'index') { void this.loadIndex(); return; }
            if (action === 'entry') { this.openEntry?.(target.dataset.entryId, target.dataset.view || 'body'); return; }
            if (action === 'steps') { void this.loadSteps(target.closest('.pi-archive-process'), Number(target.dataset.offset) || 0); return; }
            if (action === 'load') {
                const gap = target.closest('.pi-archive-gap'); if (!gap) return;
                this.failed = null;
                const [start, end] = this.portion(gap);
                void this.load(start, end);
            }
        }

        // ---- outline and history integration ---------------------------------------------------

        headNode(index) { return this.slots[index]?.querySelector(':scope > .pi-archive-head-node') || null; }

        // Archived turns in order, for the question outline.
        turns() {
            return this.items.map(item => ({ ...item, node: this.headNode(item.index) }));
        }

        // Unloaded turns sit at their placeholder.
        placeholder(index) {
            for (const gap of this.container.querySelectorAll(':scope > .pi-archive-gap')) {
                if (index >= Number(gap.dataset.start) && index < Number(gap.dataset.end)) return gap;
            }
            return null;
        }

        has(entryId) { return this.state === 'ready' && this.entries.has(entryId); }

        nodeFor(entryId) {
            const target = this.entries.get(entryId); if (!target || !this.slots[target.index]) return null;
            return target.part === 'reply' ? this.slots[target.index].querySelector(':scope > .pi-archive-reply') : this.headNode(target.index);
        }

        // Load the segment holding one turn (nearest the reader's side first) and return its node.
        async reveal(index) {
            const { key, generation } = this.context(), sequence = this.sequence;
            for (let attempt = 0; attempt < 8; attempt++) {
                if (!this.live(key, generation, sequence)) return null;
                if (this.slots[index]) return this.headNode(index);
                const run = this.run(index); if (!run) return null;
                const end = Math.min(run.end, index + 1 + (SEGMENT >> 1));
                if (!await this.load(Math.max(run.start, end - SEGMENT), end)) return null;
            }
            return this.live(key, generation, sequence) ? this.headNode(index) : null;
        }

        async revealEntry(entryId) {
            const target = this.entries.get(entryId); if (!target) return null;
            if (!await this.reveal(target.index)) return null;
            return this.nodeFor(entryId);
        }
    }

    window.PiTranscriptArchive = { create: options => new PiTranscriptArchive(options) };
})();
