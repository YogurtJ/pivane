(() => {
    // Question outline on the transcript's left edge (one tick per turn), with hover
    // previews, jumps and bookmarks. Built from the rendered transcript DOM plus the read-only
    // archive of pre-compaction turns (when present); bookmarks are native Pi labels read and
    // written through the existing history API, never a copy.
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    // Questions start turns; context summaries are shown as markers between them.
    const TURN_SELECTOR = ':scope > .pi-message.user, :scope > .pi-agent-turn-start, :scope > .pi-summary-notice';
    const GAP = { min: 6, max: 12 }, EDGE = 48, PEAK = 30, FALLOFF = [1, 0.6, 0.34, 0.16];
    const MIN_WIDTH = 560, MARK_PAGES = 100, LABEL_CHARS = 24;
    const ICON = { off: 'fa-regular fa-bookmark', on: 'fa-solid fa-bookmark' };
    const el = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
    const clean = text => String(text || '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const clip = (text, chars) => { const points = [...text]; return points.length > chars ? `${points.slice(0, chars).join('').trimEnd()}…` : text; };
    const textOf = content => typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '';
    const hasToolCall = message => Array.isArray(message?.content) && message.content.some(block => block?.type === 'toolCall');

    // Plain-text outline of a Markdown reply: paragraphs and list items only. Code,
    // tables and markup are dropped; output is inserted with textContent, never HTML.
    // Work is bounded: only the head of a long reply is scanned and each item is clipped.
    function excerpt(markdown, limit = 420) {
        const items = []; let paragraph = [], fence = null, table = false, used = 0, skipped = false;
        const inline = text => clean(text
            .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/<\/?[a-z][^>]*>/gi, '').replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
            .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1$2').replace(/`([^`]+)`/g, '$1'));
        const push = (type, text) => {
            if (used >= limit) return;
            text = clip(inline(text.slice(0, (limit - used) * 3 + 200)), limit - used);
            if (text) { items.push({ type, text }); used += text.length; }
        };
        // Join soft-wrapped lines: no space around CJK text, one space between Latin words.
        const cjk = /[\u3000-\u9fff\uff00-\uffef]/;
        const join = lines => lines.reduce((text, line) => !text ? line : text + (cjk.test(text.at(-1)) || cjk.test(line.trimStart()[0] || '') ? '' : ' ') + line.trimStart(), '');
        const flush = () => { if (paragraph.length) push('p', join(paragraph)); paragraph = []; };
        for (const line of String(markdown || '').slice(0, 16000).split(/\r\n|\r|\n/)) {
            if (used >= limit) break;
            const marker = /^\s*(`{3,}|~{3,})/.exec(line);
            if (fence) { if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null; continue; }
            if (marker) { flush(); fence = marker[1]; skipped = true; continue; }
            if (table && line.trim() && line.includes('|')) continue;
            table = false;
            // GFM tables with or without outer pipes: the delimiter row makes the line above a header.
            if (/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/.test(line)) { paragraph.pop(); flush(); table = skipped = true; continue; }
            if (/^\s*\|/.test(line)) { flush(); table = skipped = true; continue; }
            if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || !line.trim()) { flush(); continue; }
            const item = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
            const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
            if (item) { flush(); push('li', item[1]); }
            else if (heading) { flush(); push('p', heading[1]); }
            else paragraph.push(line.replace(/^\s*>\s?/, ''));
        }
        flush();
        return { items, skipped };
    }

    function formatTime(value) {
        const date = value == null ? null : new Date(value);
        if (!date || !Number.isFinite(date.getTime())) return null;
        const locale = globalThis.PiI18n?.locale || 'zh-CN';
        const options = { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
        if (date.getFullYear() !== new Date().getFullYear()) options.year = 'numeric';
        return { text: new Intl.DateTimeFormat(locale, options).format(date), iso: date.toISOString() };
    }

    class PiTranscriptTimeline {
        constructor({ host, scroller, content, archive, anchors, context, request, toast, locate, openHistory }) {
            Object.assign(this, { host, scroller, content, archive, anchors, context, request, toast, locate, openHistory });
            this.turns = []; this.hovered = -1; this.inView = new Set(); this.current = -1;
            this.enabled = false; this.key = null; this.generation = null; this.sequence = 0;
            this.marks = new Map(); this.revisions = new Map(); this.saving = new Set(); this.buttons = new WeakMap(); this.titles = new WeakMap();
            this.loading = false; this.loadAgain = false; this.markError = false;
            // Same conditions as the CSS fallback: a hover-capable fine pointer on a non-phone width.
            this.pointer = matchMedia('(hover: hover) and (pointer: fine) and (min-width: 681px)');
            this.nav = el('nav', 'pi-timeline'); this.nav.hidden = true;
            this.nav.setAttribute('aria-label', translateUi("对话目录"));
            this.rail = el('div', 'pi-timeline-rail');
            this.card = el('div', 'pi-timeline-card'); this.card.hidden = true;
            this.card.innerHTML = '<div class="pi-timeline-card-head"><p class="pi-timeline-title"></p><button type="button" class="pi-timeline-mark"><i aria-hidden="true"></i></button></div><div class="pi-timeline-reply"></div><button type="button" class="pi-timeline-history" hidden><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><span></span></button><p class="pi-timeline-meta"></p>';
            this.historyButton = this.card.querySelector('.pi-timeline-history');
            this.historyButton.lastElementChild.textContent = translateUi("搜索历史");
            this.nav.append(this.rail, this.card); host.append(this.nav);
            this.bind();
            this.observer = new MutationObserver(() => this.schedule('rebuild'));
            this.observer.observe(content, { childList: true });
            this.resize = new ResizeObserver(() => this.schedule('layout'));
            this.resize.observe(scroller); this.resize.observe(content);
            this.pointer.addEventListener?.('change', () => this.schedule('layout'));
            this.schedule('rebuild');
        }

        bind() {
            const forward = event => {
                const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.scroller.clientHeight : 1;
                this.scroller.scrollTop += event.deltaY * unit;
            };
            this.nav.addEventListener('wheel', forward, { passive: true });
            // Mouse use never moves focus off the transcript, so its keyboard scrolling keeps working.
            this.nav.addEventListener('mousedown', event => event.preventDefault());
            this.scroller.addEventListener('scroll', () => this.schedule('view'), { passive: true });
            this.rail.addEventListener('pointermove', event => {
                if (event.pointerType === 'touch') return;
                this.cancelHide(); this.hover(this.indexAt(event.clientY), false);
            });
            this.rail.addEventListener('pointerleave', () => this.scheduleHide());
            this.card.addEventListener('pointerenter', () => this.cancelHide());
            this.card.addEventListener('pointerleave', () => this.scheduleHide());
            this.rail.addEventListener('click', event => {
                const tick = event.target.closest('.pi-timeline-tick');
                const index = event.detail && event.pointerType !== 'touch' ? this.indexAt(event.clientY) : Number(tick?.dataset.index);
                if (Number.isInteger(index) && index >= 0) this.jump(index);
            });
            this.rail.addEventListener('focusin', event => {
                const tick = event.target.closest('.pi-timeline-tick');
                if (tick && tick.matches(':focus-visible')) { this.cancelHide(); this.hover(Number(tick.dataset.index), true); }
            });
            this.nav.addEventListener('focusout', event => { if (!this.nav.contains(event.relatedTarget)) this.scheduleHide(0); });
            this.rail.addEventListener('keydown', event => {
                const index = Number(event.target.closest('.pi-timeline-tick')?.dataset.index);
                if (!Number.isInteger(index)) return;
                const last = this.turns.length - 1;
                const next = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: last }[event.key];
                if (next !== undefined) { event.preventDefault(); this.focusTick(Math.max(0, Math.min(last, next))); }
                else if (event.key === 'Escape' && !this.card.hidden) { event.preventDefault(); this.hide(); }
            });
            this.card.addEventListener('keydown', event => {
                if (event.key === 'Escape') { event.preventDefault(); this.focusTick(this.hovered); this.hide(); }
            });
            this.card.addEventListener('click', event => {
                if (this.hovered < 0) return;
                if (event.target.closest('.pi-timeline-mark')) { void this.toggleMark(this.turns[this.hovered]); return; }
                if (event.target.closest('.pi-timeline-history')) { this.hide(); this.openHistory?.(); return; }
                this.jump(this.hovered);
            });
        }

        // ---- context and capabilities -------------------------------------------------

        setEnabled(enabled) { this.enabled = Boolean(enabled); this.sync(); }

        markable() {
            const c = this.context();
            return this.enabled && c.connected && c.session && !c.session.ephemeral;
        }

        sync() {
            const c = this.context();
            if (this.anchors() !== this.anchorSource) this.schedule('rebuild');
            if (this.key !== c.key || this.generation !== c.generation) {
                const sameThread = this.key === c.key;
                this.key = c.key; this.generation = c.generation; this.sequence++;
                if (!sameThread) { this.marks.clear(); this.hide(); }
                this.revisions.clear(); this.saving.clear(); this.loading = false; this.loadAgain = false; this.markError = false;
                this.loadedFor = null; this.paintMarks();
            }
            const markable = this.markable();
            if (markable && this.loadedFor !== `${c.key}:${c.generation}` && !this.loading) this.loadMarks();
            if (markable !== this.wasMarkable) { this.wasMarkable = markable; this.paintMarks(); }
        }

        changed() { if (this.markable()) this.loadMarks(); }

        // Archived turns were loaded, unloaded or replaced.
        archiveChanged() { this.schedule('rebuild'); }

        // A failed bookmark read is retried once the session settles, not in a loop.
        settled() { if (this.markError && Date.now() - this.markErrorAt > 30000 && this.markable()) this.loadMarks(); }

        // ---- turns ------------------------------------------------------------------------

        schedule(kind) {
            this.pending = kind === 'rebuild' || this.pending === 'rebuild' ? 'rebuild' : kind === 'layout' || this.pending === 'layout' ? 'layout' : 'view';
            if (this.frame) return;
            this.frame = requestAnimationFrame(() => {
                const kind = this.pending; this.frame = null; this.pending = null;
                if (kind === 'rebuild') this.rebuild();
                if (kind !== 'view') this.layout();
                this.updateView();
            });
        }

        rebuild() {
            const nodes = [...this.content.querySelectorAll(TURN_SELECTOR)];
            const anchors = this.anchorMap();
            // Pre-compaction turns come first; unloaded ones have no node until revealed.
            const archived = (this.archive?.turns() || []).map(item => ({ archive: item, node: item.node, summary: item.kind === 'summary', entryId: item.entryId || null }));
            this.turns = [...archived, ...nodes.map(node => ({ node, summary: node.matches('.pi-summary-notice'), entryId: anchors.get(node.dataset.messageKey) || null }))];
            while (this.rail.children.length > this.turns.length) this.rail.lastElementChild.remove();
            while (this.rail.children.length < this.turns.length) {
                const tick = el('button', 'pi-timeline-tick'); tick.type = 'button'; tick.tabIndex = -1;
                tick.dataset.index = String(this.rail.children.length); this.rail.append(tick);
            }
            let question = 0;
            this.turns.forEach((turn, index) => {
                const tick = turn.tick = this.rail.children[index];
                const label = turn.summary ? this.title(turn) : translateUi("第 {0} 个问题：{1}", ++question, clip(this.title(turn), 80));
                if (tick.getAttribute('aria-label') !== label) tick.setAttribute('aria-label', label);
                tick.classList.toggle('is-summary', turn.summary);
                tick.classList.remove('is-visible'); tick.removeAttribute('aria-current'); tick.tabIndex = -1;
            });
            this.inView.clear(); this.current = -1; this.tabStop = null;
            if (this.hovered >= this.turns.length) this.hide();
            else if (this.hovered >= 0 && !this.card.hidden) this.fillCard(this.hovered);
            this.paintMarks();
        }

        anchorMap() {
            const source = this.anchors();
            if (this.anchorCache && this.anchorSource === source) return this.anchorCache;
            const map = new Map();
            for (const [id, role, timestamp, toolId] of Array.isArray(source) ? source : []) {
                const key = JSON.stringify([role, timestamp, toolId || '']);
                map.set(key, map.has(key) ? null : id);
            }
            this.anchorSource = source; this.anchorCache = map;
            return map;
        }

        // Native entry ID for a rendered message node, when unambiguous.
        entryFor(node) { return node?.dataset?.messageKey ? this.anchorMap().get(node.dataset.messageKey) || null : null; }

        nodeFor(entryId) {
            if (!entryId) return null;
            for (const [key, id] of this.anchorMap()) {
                if (id !== entryId) continue;
                for (const node of this.content.querySelectorAll(`:scope > [data-message-key="${CSS.escape(key)}"]`)) if (node.isConnected) return node;
            }
            return this.archive?.nodeFor(entryId) || null;
        }

        // Rendered questions never change in place, so their outline text is cached per node.
        title(turn) {
            if (!turn.node) {
                const item = turn.archive;
                if (turn.summary) return item.summaryType === 'branch_summary' ? translateUi("分支摘要") : translateUi("上下文已压缩");
                const text = clean(item.title);
                if (item.kind === 'agent' && item.customType === 'pivane-channel-message') {
                    const body = text.replace(/^\[用户通过已绑定的微信私聊发来消息。[\s\S]*?\]\s*/, '').trim();
                    return [translateUi("微信"), body].filter(Boolean).join(' · ') || translateUi("无文字正文");
                }
                if (item.kind === 'agent') return [item.customType, text].filter(Boolean).join(' · ') || translateUi("无文字正文");
                return text || (item.images ? translateUi("图片附件 {0} 张", item.images) : translateUi("无文字正文"));
            }
            let text = this.titles.get(turn.node);
            if (text === undefined) { text = this.readTitle(turn.node); this.titles.set(turn.node, text); }
            return text;
        }

        readTitle(node) {
            if (node.matches('.pi-summary-notice')) return clean(node.querySelector(':scope > summary strong')?.textContent) || translateUi("摘要");
            if (node.matches('.pi-message.user')) {
                const prefix = node.matches('.pi-channel-message') ? `${translateUi("微信")} · ` : '';
                const body = node.querySelector('.pi-message-body');
                for (const block of body?.querySelectorAll('.pi-markdown p') || []) {
                    if (block.closest('.pi-quote-card')) continue;
                    const text = clean(block.textContent); if (text) return `${prefix}${text}`;
                }
                const quote = clean(body?.querySelector('.pi-quote-preview')?.textContent);
                if (quote) return `${prefix}${translateUi("引用")} · ${quote}`;
                const file = clean(body?.querySelector('.pi-document-card strong')?.textContent);
                if (file) return `${prefix}${file}`;
                const images = body?.querySelectorAll('.pi-message-image').length || 0;
                return images ? `${prefix}${translateUi("图片附件 {0} 张", images)}` : `${prefix}${translateUi("无文字正文")}`;
            }
            // Scheduled tasks and Agent handoffs: "<card kind> · <first body line>".
            const message = node._piCustomMessage, offset = message?.details?.bodyOffset;
            const body = textOf(message?.content).slice(Number.isInteger(offset) && offset >= 0 ? offset : 0);
            const kind = clean(node.querySelector(':scope > header strong')?.textContent);
            const text = clean(body.split(/\n/).find(line => line.trim()));
            return [kind, text].filter(Boolean).join(' · ') || translateUi("无文字正文");
        }

        // The turn's last readable reply; falls back to progress text while it is running.
        reply(index) {
            const item = this.turns[index].archive;
            if (item && !this.turns[index].node) {
                return { message: item.reply?.excerpt ? { content: item.reply.excerpt } : null, running: false, continues: Boolean(item.continues),
                    failed: item.reply?.failed ? translateUi("回复失败") : null, stopped: item.reply?.stopReason === 'aborted' };
            }
            if (item?.continues) return { message: null, running: false, continues: true };
            const end = this.turns[index + 1]?.node || null;
            let final = null, running = false, failed = null, stopped = false;
            for (let node = this.turns[index].node.nextElementSibling; node && node !== end; node = node.nextElementSibling) {
                if (!node.matches('.pi-message.assistant')) continue;
                const message = node._piAssistantMessage;
                if (!message) { running = true; continue; }
                if (textOf(message.content).trim()) final = message;
                if (message.errorMessage || message.stopReason === 'error') failed = message.errorMessage || translateUi("回复失败");
                if (message.stopReason === 'aborted') stopped = true;
            }
            return { message: final, running: running || (!final && index === this.turns.length - 1 && this.context().streaming), failed, stopped };
        }

        // ---- layout and painting ---------------------------------------------------------

        visible() {
            return this.turns.length >= 2 && this.pointer.matches && this.host.clientWidth >= MIN_WIDTH && this.host.clientHeight >= 240;
        }

        layout() {
            const show = this.visible();
            this.nav.hidden = !show;
            // Narrow layouts reserve a left gutter so the ticks never sit on message text.
            this.host.parentElement?.classList.toggle('pi-has-outline', show);
            if (!show) { this.hide(); return; }
            const available = Math.max(0, this.host.clientHeight - EDGE * 2), count = this.turns.length;
            this.gap = Math.max(GAP.min, Math.min(GAP.max, Math.floor(available / count)));
            const height = Math.min(available, this.gap * count);
            this.rail.style.setProperty('--gap', `${this.gap}px`);
            this.rail.style.height = `${height}px`;
            this.rail.classList.toggle('is-dense', this.gap < 9);
        }

        updateView() {
            if (this.nav.hidden || !this.turns.length) return;
            const top = this.scroller.scrollTop, bottom = top + this.scroller.clientHeight, focus = top + this.scroller.clientHeight * 0.3;
            // A marker folded into a closed turn has no box: measure the nearest visible node
            // before it, and keep ranges ordered so a hidden marker cannot invert them.
            let floor = 0;
            const placeholder = this.archive?.placeholderLookup?.();
            const offsets = new Map();
            const starts = this.turns.map(turn => {
                const node = turn.node || (turn.archive ? (placeholder ? placeholder(turn.archive.index) : this.archive.placeholder(turn.archive.index)) : null);
                if (!offsets.has(node)) {
                    let visible = node;
                    while (visible && (visible.hidden || !visible.offsetParent)) visible = visible.previousElementSibling;
                    offsets.set(node, visible ? visible.offsetTop : 0);
                }
                return floor = Math.max(floor, offsets.get(node));
            });
            const next = new Set(); let current = -1;
            for (let i = 0; i < starts.length; i++) {
                const end = i + 1 < starts.length ? starts[i + 1] : this.content.offsetTop + this.content.offsetHeight;
                if (end > top + 4 && starts[i] < bottom - 4) next.add(i);
                if (starts[i] <= focus) current = i;
            }
            if (current < 0) current = 0;
            for (const i of this.inView) if (!next.has(i)) this.turns[i]?.tick.classList.remove('is-visible');
            for (const i of next) this.turns[i].tick.classList.add('is-visible');
            this.inView = next;
            if (current !== this.current) {
                this.turns[this.current]?.tick.removeAttribute('aria-current');
                this.current = current;
                this.turns[current].tick.setAttribute('aria-current', 'location');
            }
            // The tab stop follows the reading position unless the keyboard is inside the outline.
            const focused = this.rail.contains(document.activeElement) ? Number(document.activeElement.dataset.index) : NaN;
            this.setTabStop(Number.isInteger(focused) ? focused : current);
            // A long outline scrolls with the conversation unless the reader is aiming at it.
            if (this.rail.scrollHeight > this.rail.clientHeight + 1 && this.hovered < 0) {
                const first = Math.min(...next), last = Math.max(...next);
                const middle = ((Number.isFinite(first) ? first : current) + (Number.isFinite(last) ? last : current) + 1) / 2 * this.gap;
                this.rail.scrollTop = middle - this.rail.clientHeight / 2;
            }
        }

        indexAt(y) {
            const box = this.rail.getBoundingClientRect();
            const index = Math.floor((y - box.top + this.rail.scrollTop) / this.gap);
            return Math.max(0, Math.min(this.turns.length - 1, index));
        }

        lens(center) {
            const touched = new Set([...(this.lensed || [])]);
            this.lensed = [];
            if (center >= 0) for (let d = -FALLOFF.length + 1; d < FALLOFF.length; d++) {
                const i = center + d; if (i < 0 || i >= this.turns.length) continue;
                this.turns[i].tick.style.setProperty('--lens', String(FALLOFF[Math.abs(d)])); this.lensed.push(i); touched.delete(i);
            }
            for (const i of touched) this.turns[i]?.tick.style.removeProperty('--lens');
            this.hoverTick?.classList.remove('is-hovered');
            this.hoverTick = this.turns[center]?.tick || null;
            this.hoverTick?.classList.add('is-hovered');
            this.nav.classList.toggle('is-active', center >= 0);
        }

        hover(index, keyboard) {
            if (index < 0 || index >= this.turns.length) return;
            if (index !== this.hovered || this.card.hidden) { this.hovered = index; this.lens(index); this.fillCard(index); }
            this.card.dataset.input = keyboard ? 'keyboard' : 'pointer';
        }

        // Exactly one tick is tabbable (roving tabindex).
        setTabStop(index) {
            if (this.tabStop === index && this.turns[index]?.tick.tabIndex === 0) return;
            const previous = this.turns[this.tabStop]?.tick; if (previous) previous.tabIndex = -1;
            this.tabStop = this.turns[index] ? index : null;
            if (this.tabStop != null) this.turns[index].tick.tabIndex = 0;
        }

        focusTick(index) {
            const turn = this.turns[index]; if (!turn) return;
            this.setTabStop(index); turn.tick.focus({ preventScroll: true });
            // A long, clipped outline scrolls itself so the keyboard target stays visible.
            const top = index * this.gap, bottom = top + this.gap;
            if (top < this.rail.scrollTop) this.rail.scrollTop = top;
            else if (bottom > this.rail.scrollTop + this.rail.clientHeight) this.rail.scrollTop = bottom - this.rail.clientHeight;
            this.hover(index, true);
        }

        fillCard(index) {
            const turn = this.turns[index]; if (!turn) return;
            const title = this.card.querySelector('.pi-timeline-title'), replyNode = this.card.querySelector('.pi-timeline-reply'), meta = this.card.querySelector('.pi-timeline-meta');
            title.textContent = this.title(turn); title.title = title.textContent;
            replyNode.replaceChildren();
            this.card.classList.toggle('is-summary', turn.summary);
            const { message, running, failed, stopped, continues } = turn.summary ? {} : this.reply(index);
            const compaction = turn.summary && (turn.node ? turn.node.matches('.compactionSummary') : turn.archive.summaryType !== 'branch_summary');
            const { items, skipped } = message ? excerpt(textOf(message.content)) : { items: [], skipped: false };
            let list = null;
            for (const item of items.slice(0, 6)) {
                if (item.type === 'li') { if (!list) replyNode.append(list = el('ul')); list.append(el('li', null, item.text)); }
                else { list = null; replyNode.append(el('p', null, item.text)); }
            }
            const state = turn.summary ? (compaction ? translateUi("更早的对话已压缩为摘要，点击查看；压缩前的原文可在历史中搜索。") : translateUi("离开其他分支时留下的摘要，点击查看。"))
                : continues ? translateUi("这一轮后续的执行和回复在下方的当前上下文中")
                : !message && running ? translateUi("回复生成中…") : failed && !items.length ? failed
                : stopped && !items.length ? translateUi("回复已停止") : !items.length ? (skipped ? translateUi("回复包含代码或表格，点击查看") : translateUi("暂无文字回复")) : '';
            if (state) replyNode.append(el('p', 'pi-timeline-state', state));
            this.historyButton.hidden = !(compaction && this.openHistory);
            replyNode.classList.toggle('is-running', Boolean(running && message));
            const time = formatTime(turn.node ? (turn.node._piUserMessage || turn.node._piCustomMessage)?.timestamp : turn.archive.timestamp);
            const mark = turn.entryId ? this.marks.get(turn.entryId) : null;
            meta.replaceChildren();
            if (time) { const node = el('time', null, time.text); node.dateTime = time.iso; meta.append(node); }
            if (mark?.label && mark.label !== this.autoLabel(turn)) {
                const label = el('span', 'pi-timeline-label'); label.append(el('i', 'fa-solid fa-bookmark'), document.createTextNode(clip(mark.label, 40)));
                label.firstChild.setAttribute('aria-hidden', 'true'); label.title = mark.label; meta.prepend(label);
            }
            meta.hidden = !meta.childElementCount;
            this.paintCardMark(turn);
            const wasHidden = this.card.hidden;
            this.card.hidden = false;
            this.position(index);
            if (wasHidden) { this.card.classList.remove('is-open'); void this.card.offsetWidth; }
            this.card.classList.add('is-open');
        }

        position(index) {
            const rail = this.rail.getBoundingClientRect(), host = this.host.getBoundingClientRect();
            const center = rail.top - host.top + (index + 0.5) * this.gap - this.rail.scrollTop;
            const height = this.card.offsetHeight, limit = this.host.clientHeight - height - 8;
            this.card.style.top = `${Math.round(Math.max(8, Math.min(limit, center - height / 2)))}px`;
        }

        scheduleHide(delay = 160) {
            clearTimeout(this.hideTimer);
            this.hideTimer = setTimeout(() => {
                if (this.nav.matches(':hover') || this.nav.contains(document.activeElement) && this.card.dataset.input === 'keyboard') return;
                this.hide();
            }, delay);
        }

        cancelHide() { clearTimeout(this.hideTimer); }

        hide() {
            clearTimeout(this.hideTimer);
            this.hovered = -1; this.card.hidden = true; this.card.classList.remove('is-open');
            if (this.turns.length) this.lens(-1);
        }

        async jump(index) {
            let turn = this.turns[index]; if (!turn) return;
            if (turn.archive && !turn.node?.isConnected) {
                // Load the archived segment first; give up if the thread changed meanwhile.
                const key = this.key, item = turn.archive;
                const node = await this.archive.reveal(item.index);
                if (!node || key !== this.key) return;
                turn = { ...turn, node };
            }
            if (!turn.node?.isConnected) return;
            if (turn.summary && !turn.node.open) turn.node.open = true;
            this.locate(turn.node);
            requestAnimationFrame(() => this.updateView());
        }

        // ---- bookmarks ---------------------------------------------------------------------

        autoLabel(turn) { return clip(this.title(turn), LABEL_CHARS) || translateUi("书签"); }

        // The question header button exists only while this turn can actually be bookmarked.
        decorate(turn, ready) {
            if (!turn.node) return null;
            const current = this.buttons.get(turn.node);
            if (!ready) { current?.remove(); this.buttons.delete(turn.node); return null; }
            const actions = turn.node.matches('.pi-message.user') ? turn.node.querySelector(':scope > header .pi-user-actions') : null;
            if (!actions || current) return current || null;
            const button = el('button', 'pi-message-bookmark pi-message-action'); button.type = 'button';
            button.innerHTML = '<i aria-hidden="true"></i>';
            button.addEventListener('click', () => {
                const target = this.turns.find(item => item.node === turn.node);
                if (target) void this.toggleMark(target);
            });
            actions.prepend(button); this.buttons.set(turn.node, button);
            return button;
        }

        paintButton(button, turn) {
            // Summaries are landmarks, not questions: they show existing labels but take no new bookmarks.
            const ready = this.markable() && Boolean(turn.entryId) && !turn.summary, mark = turn.entryId ? this.marks.get(turn.entryId) : null;
            const busy = Boolean(turn.entryId && this.saving.has(turn.entryId));
            button.hidden = !ready;
            button.setAttribute('aria-pressed', String(Boolean(mark)));
            button.setAttribute('aria-busy', String(busy));
            button.disabled = busy;
            button.firstElementChild.className = mark ? ICON.on : ICON.off;
            button.title = mark ? translateUi("移除书签：{0}", clip(mark.label, 40)) : translateUi("添加书签");
            button.setAttribute('aria-label', button.title);
        }

        paintCardMark(turn) { this.paintButton(this.card.querySelector('.pi-timeline-mark'), turn); }

        paintMarks() {
            const markable = this.markable();
            for (const turn of this.turns) {
                const marked = Boolean(turn.entryId && this.marks.has(turn.entryId));
                turn.tick.classList.toggle('is-marked', marked);
                const button = this.decorate(turn, markable && Boolean(turn.entryId) && !turn.summary); if (button) this.paintButton(button, turn);
            }
            if (this.hovered >= 0 && !this.card.hidden && this.turns[this.hovered]) this.paintCardMark(this.turns[this.hovered]);
        }

        current_(key, generation) { const c = this.context(); return c.key === key && c.generation === generation; }

        async loadMarks() {
            if (this.loading) { this.loadAgain = true; return; }
            const { key, generation } = this.context(), sequence = this.sequence;
            this.loading = true; this.loadAgain = false;
            const marks = new Map();
            try {
                let offset = 0, revision = null, complete = false;
                for (let page = 0; page < MARK_PAGES && !complete; page++) {
                    // All branches: a later tree navigation must not need another read.
                    const data = await this.request('search_history', { q: '', scope: 'all', filter: 'all', bookmarked: true, offset, ...(offset ? { revision } : {}) });
                    if (!this.current_(key, generation) || sequence !== this.sequence) return;
                    for (const row of data.results || []) if (row.label && row.entryId) marks.set(row.entryId, { label: row.label, revision: row.bookmarkRevision });
                    revision = data.revision; offset = data.offset + (data.results || []).length;
                    complete = !data.hasMore;
                }
                // Beyond the page budget, keep what earlier reads knew instead of showing it as unmarked.
                if (!complete) for (const [id, mark] of this.marks) if (!marks.has(id)) marks.set(id, mark);
                // A write still in flight owns its entry until its own result (and broadcast) arrives.
                for (const id of this.saving) { if (this.marks.has(id)) marks.set(id, this.marks.get(id)); else marks.delete(id); }
                this.marks = marks; this.markError = false; this.loadedFor = `${key}:${generation}`;
                // Only freshly read revisions are trusted; unknown ones are re-read before a write.
                this.revisions = new Map([...marks].map(([id, mark]) => [id, mark.revision]));
            } catch {
                // Bookmarks are an enhancement: keep the previous state and retry on a later change.
                if (this.current_(key, generation) && sequence === this.sequence) { this.markError = true; this.markErrorAt = Date.now(); this.loadedFor = `${key}:${generation}`; }
            } finally {
                if (sequence === this.sequence) {
                    this.loading = false; this.paintMarks();
                    if (this.loadAgain && this.markable()) this.loadMarks();
                }
            }
        }

        async toggleMark(turn) {
            if (!turn || turn.summary || !this.markable()) return;
            const entryId = turn.entryId;
            if (!entryId) { this.toast(translateUi("这条消息尚未保存，请稍后再添加书签"), 'info'); return; }
            if (this.saving.has(entryId)) return;
            const { key, generation } = this.context(), sequence = this.sequence;
            const live = () => this.current_(key, generation) && sequence === this.sequence;
            const existing = this.marks.get(entryId);
            let revision = existing?.revision || this.revisions.get(entryId);
            this.saving.add(entryId); this.paintMarks();
            try {
                if (!existing && !revision) {
                    // Unknown revision (for example, a label cleared before this page opened):
                    // read the authoritative native state first instead of guessing "none".
                    const data = await this.request('get_history_entry', { entryId, offset: 0 });
                    if (!live()) return;
                    revision = data.bookmarkRevision; this.revisions.set(entryId, revision);
                    if (data.label) { this.marks.set(entryId, { label: data.label, revision }); return; }
                    if (!data.canBookmark) throw new Error(translateUi("首条回复保存后可添加书签"));
                }
                const data = await this.request('set_history_bookmark', { entryId, label: existing ? '' : this.autoLabel(turn), expectedBookmarkRevision: revision });
                if (!live()) return;
                this.revisions.set(entryId, data.bookmarkRevision);
                if (data.label) this.marks.set(entryId, { label: data.label, revision: data.bookmarkRevision }); else this.marks.delete(entryId);
            } catch (error) {
                if (!live()) return;
                // Never retried automatically; refresh the native state so the next click is informed.
                this.revisions.delete(entryId);
                this.toast(error.message, 'error');
                this.loadMarks();
            } finally {
                if (live()) { this.saving.delete(entryId); this.paintMarks(); }
            }
        }
    }

    window.PiTranscriptTimeline = { create: options => new PiTranscriptTimeline(options), excerpt };
})();
