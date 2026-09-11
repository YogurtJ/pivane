(() => {
    function describe(result) {
        const patch = typeof result?.details?.patch === 'string' ? result.details.patch : '';
        const source = patch || (typeof result?.details?.diff === 'string' ? result.details.diff : '');
        if (!source.trim()) return null;
        const lines = source.split('\n'), kinds = [];
        let oldRemaining = 0, newRemaining = 0, hunks = 0, valid = true, added = 0, removed = 0;
        for (const line of lines) {
            const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
            if (patch && hunk) {
                if (oldRemaining || newRemaining) valid = false;
                oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1); hunks++;
                kinds.push('hunk'); continue;
            }
            const inHunk = !patch || oldRemaining > 0 || newRemaining > 0;
            const kind = inHunk && line.startsWith('+') ? 'added' : inHunk && line.startsWith('-') ? 'removed' : '';
            kinds.push(kind);
            if (kind === 'added') { added++; if (patch) newRemaining--; }
            else if (kind === 'removed') { removed++; if (patch) oldRemaining--; }
            else if (patch && inHunk && line.startsWith(' ')) { oldRemaining--; newRemaining--; }
            else if (patch && inHunk && !line.startsWith('\\')) valid = false;
            if (oldRemaining < 0 || newRemaining < 0) valid = false;
            if (patch && !inHunk && (/^[+-]/.test(line) && !/^(---|\+\+\+) /.test(line) || line.startsWith('@@'))) valid = false;
        }
        return { patch, source, lines, kinds, counts: patch && hunks && valid && !oldRemaining && !newRemaining ? { added, removed } : null };
    }

    function panel(info, path, copy, notify) {
        const section = document.createElement('section'); section.className = 'pi-edit-diff'; section.setAttribute('aria-label', '代码修改');
        const head = document.createElement('div'); head.className = 'pi-diff-heading';
        const name = document.createElement('strong'); name.textContent = path || '文件修改'; head.append(name);
        const count = document.createElement('span');
        count.textContent = info.counts ? `+${info.counts.added} / −${info.counts.removed}` : '原始差异 · 行数未统计'; head.append(count);
        if (info.patch) {
            const button = document.createElement('button'); button.type = 'button'; button.textContent = '复制 patch';
            button.addEventListener('click', () => copy(info.patch).then(() => notify('已复制 patch', 'success')).catch(error => notify(error.message, 'error')));
            head.append(button);
        }
        section.append(head);
        const code = document.createElement('pre'); code.className = 'pi-diff-code'; code.tabIndex = 0; code.setAttribute('aria-label', '修改差异，可滚动');
        // Keep the full text of large patches without creating thousands of line elements.
        if (info.source.length > 500000 || info.lines.length > 4000) code.textContent = info.source;
        else {
            let oldLine = null, newLine = null;
            for (const [index, line] of info.lines.entries()) {
                const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
                const span = document.createElement('span'); span.className = 'pi-diff-line';
                const gutter = document.createElement('span'); gutter.className = 'pi-diff-gutter'; gutter.setAttribute('aria-hidden', 'true');
                if (info.patch && hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
                else if (info.patch && oldLine !== null && /^[ +\-]/.test(line)) {
                    const before = line[0] === '+' ? '' : String(oldLine++);
                    const after = line[0] === '-' ? '' : String(newLine++);
                    gutter.textContent = `${before.padStart(5)} ${after.padStart(5)} `;
                }
                if (info.kinds[index]) span.classList.add(info.kinds[index]);
                span.append(gutter, document.createTextNode(`${line}\n`)); code.append(span);
            }
        }
        section.append(code);
        return section;
    }

    function render(row, result, copy, notify) {
        if (row.dataset.toolName !== 'edit') return;
        const info = describe(result);
        if (!info) { row.querySelector('.pi-edit-diff')?.remove(); row._piDiffSource = null; return; }
        if (row._piDiffSource === info.source) return;
        row._piDiffSource = info.source;
        row.querySelector('.pi-edit-diff')?.remove();
        const path = typeof row._piToolArgs?.path === 'string' ? row._piToolArgs.path : info.patch.match(/^\+\+\+ ([^\t\n]+)/m)?.[1];
        row.querySelector('.pi-tool-detail').prepend(panel(info, path, copy, notify));
        if (!row.querySelector('.pi-tool-raw')) {
            const raw = document.createElement('details'); raw.className = 'pi-tool-raw';
            raw.dataset.detailKey = `${row.dataset.detailKey}:arguments`;
            const summary = document.createElement('summary'); summary.textContent = '原始修改参数'; raw.append(summary);
            const args = row.querySelector('.pi-tool-args'); args.before(raw); raw.append(args);
        }
    }
    window.PiToolDiff = { render, describe, panel };
})();
