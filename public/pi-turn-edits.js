(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const textOf = message => typeof message.content === 'string' ? message.content : (Array.isArray(message.content) ? message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '');

    // Derived exclusively from the loaded native messages. No disk reads or saved history.
    function collect(messages, running) {
        const segments = [];
        let segment = null;
        messages.forEach((message, index) => {
            if (message.role === 'user') {
                segment = { timestamp: message.timestamp, label: textOf(message).trim().slice(0, 100) || translateUi("附件问题"), endIndex: index, calls: new Map(), results: new Map() };
                segments.push(segment);
            } else if (['compactionSummary', 'branchSummary'].includes(message.role)) {
                segment = null; // Never attach orphaned context to another question.
            }
            if (!segment) return;
            segment.endIndex = index;
            if (message.role === 'assistant' && Array.isArray(message.content)) {
                for (const call of message.content) {
                    if (call.type !== 'toolCall' || !call.id) continue;
                    // Ambiguous reused IDs cannot establish a reliable file association.
                    segment.calls.set(call.id, segment.calls.has(call.id) ? null : call);
                }
            } else if (message.role === 'toolResult' && message.toolCallId) segment.results.set(message.toolCallId, message);
        });
        return segments.flatMap((part, index) => {
            if (running && index === segments.length - 1) return [];
            const files = new Map();
            for (const [id, call] of part.calls) {
                const result = part.results.get(id);
                if (!['edit', 'write'].includes(call?.name) || !result || result.isError || result.toolName && result.toolName !== call.name
                    || typeof call.arguments?.path !== 'string' || !call.arguments.path.trim()) continue;
                const path = call.arguments.path;
                if (call.name === 'write') {
                    if (typeof call.arguments.content !== 'string' || window.PiFilePolicy.restricted(path)) continue;
                    if (!files.has(path)) files.set(path, { path, edits: [], writes: [], firstId: id });
                    files.get(path).writes.push({ id, content: call.arguments.content });
                } else {
                    const info = window.PiToolDiff.describe(result);
                    if (!info) continue;
                    if (!files.has(path)) files.set(path, { path, edits: [], writes: [], firstId: id });
                    files.get(path).edits.push({ id, result, source: info.source, counts: info.counts });
                }
            }
            if (!files.size) return [];
            return [{ key: `edits:${JSON.stringify([part.timestamp ?? index, [...files.values()][0].firstId])}`, label: `${index + 1}. ${part.label}`, endIndex: part.endIndex, files: [...files.values()] }];
        });
    }

    class PiTurnEdits {
        constructor({ transcript, showPane, copy, notify, context, api }) {
            Object.assign(this, { transcript, showPane, copy, notify, context });
            this.viewer = new window.PiFileViewer({ context, api, copy, notify });
            this.rounds = new Map(); this.selection = null; this.renderedFile = null; this.external = null;
            document.addEventListener('click', event => {
                const link = event.target.closest('a[href]');
                if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || !link
                    || !link.closest('#pi-transcript-content .assistant .pi-markdown, #pi-side-messages .assistant .pi-markdown, .pi-file-markdown')) return;
                const target = window.PiFileViewer.linkTarget(link.getAttribute('href'));
                if (!target) return;
                event.preventDefault();
                this.external = { ...target, edits: [], writes: [] }; this.selection = null; this.returnLink = link;
                this.closePickers(); this.renderPane(); this.showPane('changes'); $('pi-changes-title').focus({ preventScroll: true });
            });
            this.pane = $('pi-changes');
            $('pi-changes-tab').addEventListener('click', () => {
                this.selection ||= this.rounds.size ? { key: [...this.rounds.keys()].at(-1) } : null;
                this.renderPane(); this.showPane('changes');
            });
            $('pi-changes-round').addEventListener('change', event => {
                this.external = null; this.selection = { key: event.target.value }; this.renderPane();
            });
            const closeOutside = event => {
                for (const id of ['pi-changes-file-list', 'pi-file-info']) {
                    const menu = $(id);
                    if (menu.open && !menu.contains(event.target)) menu.open = false;
                }
            };
            document.addEventListener('pointerdown', closeOutside);
            document.addEventListener('focusin', closeOutside);
            $('pi-close-inspector').addEventListener('click', () => {
                this.closePickers();
                if ($('pi-inspector').classList.contains('show-changes')) this.returnFocus();
            });
            $('pi-inspector').addEventListener('keydown', event => {
                if (event.key !== 'Escape' || event.isComposing || !$('pi-inspector').classList.contains('show-changes') || document.querySelector('dialog[open]')) return;
                event.preventDefault(); event.stopPropagation();
                const menu = ['pi-file-info', 'pi-changes-file-list'].map($).find(node => node.open);
                if (menu) { menu.open = false; menu.querySelector('summary').focus({ preventScroll: true }); return; }
                $('pi-inspector').classList.remove('open'); this.returnFocus();
            });
            this.renderPane();
        }
        closePickers() { $('pi-changes-file-list').open = false; $('pi-file-info').open = false; }
        reset() {
            this.closePickers();
            this.viewer.clear(); this.external = null; this.returnLink = null;
            this.rounds.clear(); this.selection = null; this.renderedFile = null; this.returnTarget = null;
            this.renderPane();
        }
        refresh(messages, running) {
            const rounds = collect(messages, running);
            this.rounds = new Map(rounds.map(round => [round.key, round]));
            if (this.selection && !this.rounds.has(this.selection.key)) this.selection = null;
            this.renderPane();
            return new Map(rounds.map(round => [round.endIndex, this.card(round)]));
        }
        remove(key) {
            this.rounds.delete(key);
            if (this.selection?.key === key) this.selection = null;
            this.renderPane();
        }
        fileButton(file, choose, selected = false) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'pi-edit-file';
            button.dataset.editPath = file.path;
            const name = document.createElement('span'); name.className = 'pi-edit-path';
            const prefix = this.context().cwd.replace(/\/$/, '') + '/';
            name.textContent = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
            name.title = file.path;
            const meta = document.createElement('span'); meta.className = 'pi-edit-count';
            const known = file.edits.every(edit => edit.counts);
            const added = file.edits.reduce((sum, edit) => sum + (edit.counts?.added || 0), 0);
            const removed = file.edits.reduce((sum, edit) => sum + (edit.counts?.removed || 0), 0);
            if (file.edits.length) {
                meta.append(translateUi("{0} 次 · ", file.edits.length));
                if (known) {
                    const plus = document.createElement('span'); plus.className = 'pi-edit-added'; plus.textContent = `+${added}`;
                    const minus = document.createElement('span'); minus.className = 'pi-edit-removed'; minus.textContent = `−${removed}`;
                    meta.append(plus, ' ', minus);
                } else meta.append(translateUi("行数未知"));
            }
            if (file.writes.length) meta.append(translateUi("{0}写入 {1} 次", file.edits.length ? ' · ' : '', file.writes.length));
            meta.title = translateUi("编辑行数为累计；写入可能是新建，也可能覆盖已有文件");
            button.setAttribute('aria-label', translateUi("查看 {0} 的文件记录", file.path));
            if (selected) button.setAttribute('aria-current', 'true');
            button.append(name, meta); button.addEventListener('click', choose);
            return button;
        }
        card(round) {
            const card = document.createElement('section'); card.className = 'pi-turn-edits';
            card.dataset.editRound = round.key; card.dataset.messageKey = round.key; card.dataset.readingKey = round.key;
            card.setAttribute('aria-label', translateUi("本轮文件"));
            const heading = document.createElement('div'); heading.className = 'pi-turn-edits-heading';
            const title = document.createElement('strong'); title.textContent = translateUi("本轮文件 · {0} 个文件", round.files.length);
            const note = document.createElement('small'); note.textContent = translateUi("成功编辑 / 写入 · 编辑行数为累计");
            heading.append(title, note); card.append(heading);
            const add = (host, file) => host.append(this.fileButton(file, () => {
                this.external = null; this.returnLink = null;
                this.returnTarget = { key: round.key, path: file.path };
                this.selection = { ...this.returnTarget }; this.closePickers(); this.renderPane(); this.showPane('changes');
                $('pi-changes-title').focus({ preventScroll: true });
            }));
            round.files.slice(0, 3).forEach(file => add(card, file));
            if (round.files.length > 3) {
                const more = document.createElement('details'); more.className = 'pi-edits-more'; more.dataset.detailKey = `${round.key}:more`;
                const summary = document.createElement('summary'); summary.textContent = translateUi("其余 {0} 个文件", round.files.length - 3); more.append(summary);
                round.files.slice(3).forEach(file => add(more, file));
                const collapse = document.createElement('button'); collapse.type = 'button'; collapse.className = 'pi-edits-collapse';
                collapse.textContent = translateUi("▴ 收起文件"); collapse.setAttribute('aria-expanded', 'true');
                collapse.addEventListener('click', () => {
                    more.open = false; summary.focus({ preventScroll: true });
                    summary.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                });
                // Only an explicit disclosure action moves focus; restored snapshots keep their reading position.
                summary.addEventListener('click', () => requestAnimationFrame(() => {
                    if (more.isConnected && more.open) more.querySelector('.pi-edit-file').focus({ preventScroll: true });
                }));
                more.append(collapse); card.append(more);
            }
            return card;
        }
        returnFocus() {
            if (this.returnLink?.isConnected) { this.returnLink.focus({ preventScroll: true }); return; }
            const card = [...this.transcript.querySelectorAll('.pi-turn-edits')].find(node => node.dataset.editRound === this.returnTarget?.key);
            const button = card && [...card.querySelectorAll('.pi-edit-file')].find(node => node.dataset.editPath === this.returnTarget?.path);
            (button || $('pi-toggle-inspector')).focus({ preventScroll: true });
        }
        renderPane() {
            const picker = $('pi-changes-round');
            const options = [...this.rounds.values()];
            if (picker.options.length !== options.length || options.some((r, i) => picker.options[i]?.value !== r.key || picker.options[i]?.textContent !== r.label)) {
                picker.replaceChildren(...options.map(round => new Option(round.label, round.key)));
            }
            const round = this.rounds.get(this.selection?.key);
            const present = Boolean(round || this.external);
            $('pi-changes-empty').hidden = present;
            $('pi-changes-content').hidden = !present;
            picker.closest('label').hidden = Boolean(this.external);
            $('pi-changes-files').hidden = Boolean(this.external);
            $('pi-changes-file-list').hidden = Boolean(this.external);
            $('pi-changes-file-list').querySelector('summary').textContent = translateUi("切换文件 · {0}", round?.files.length || 0);
            if (this.external) {
                $('pi-changes-diffs').replaceChildren(); this.renderedFile = null;
                this.viewer.setFile({ ...this.external, identity: `link:${this.external.path}:${this.external.line}`, hasDiff: false });
                return;
            }
            if (!round) {
                this.closePickers(); this.viewer.clear();
                $('pi-changes-files').replaceChildren(); $('pi-changes-diffs').replaceChildren(); this.renderedFile = null;
                $('pi-changes-empty').textContent = this.rounds.size ? translateUi("点击回复下方的文件查看记录，或重新点击“文件”查看最近一轮。") : translateUi("暂无文件记录。成功编辑、写入的文件会在本轮结束后显示；也可点击回复中的文件链接。");
                return;
            }
            picker.value = round.key;
            const file = round.files.find(file => file.path === this.selection.path) || round.files[0]; this.selection.path = file.path;
            this.viewer.setFile({ ...file, identity: `${round.key}:${file.path}`, hasDiff: file.edits.length > 0 });
            const previous = this.renderedFile;
            // Reconnection and settled snapshots must not reset the selected diff's scroll/details/focus.
            const sameFiles = previous?.round.key === round.key && previous.round.files.length === round.files.length
                && previous.round.files.every((old, i) => old.path === round.files[i].path && old.edits.length === round.files[i].edits.length
                    && old.writes.length === round.files[i].writes.length && old.writes.every((w, j) => w.id === round.files[i].writes[j].id && w.content === round.files[i].writes[j].content)
                    && old.edits.every((edit, j) => edit.source === round.files[i].edits[j].source && edit.id === round.files[i].edits[j].id));
            if (sameFiles && previous.file.path === file.path) return;
            const list = $('pi-changes-files'); list.replaceChildren();
            for (const entry of round.files) list.append(this.fileButton(entry, () => {
                this.selection.path = entry.path; this.closePickers(); this.renderPane();
                $('pi-changes-title').focus({ preventScroll: true });
            }, entry.path === file.path));
            const diffs = $('pi-changes-diffs'); diffs.replaceChildren();
            for (const [index, edit] of file.edits.entries()) {
                const details = document.createElement('details'); details.className = 'pi-edit-record';
                const summary = document.createElement('summary'); summary.textContent = translateUi("第 {0} 次编辑{1}", index + 1, edit.counts ? '' : translateUi(" · 原始差异"));
                details.append(summary);
                let rendered = false;
                const load = () => {
                    if (!details.open || rendered) return;
                    rendered = true;
                    details.append(window.PiToolDiff.panel(window.PiToolDiff.describe(edit.result), file.path, this.copy, this.notify));
                };
                details.addEventListener('toggle', load); details.open = index === 0; load(); diffs.append(details);
            }
            diffs.scrollTop = 0;
            this.renderedFile = { round, file };
        }
    }
    window.PiTurnEdits = PiTurnEdits;
})();
