(() => {
    const $ = id => document.getElementById(id);
    const languages = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', sql: 'sql', rb: 'ruby', php: 'php', ini: 'ini', toml: 'ini', diff: 'diff' };
    function linkTarget(href, base = '') {
        if (typeof href !== 'string' || !href) return null;
        let decoded = false;
        if (href.startsWith('#pi-file=')) { try { href = decodeURIComponent(href.slice(9)); decoded = true; } catch { return null; } }
        else if (href.startsWith('#')) return null;
        if (/^file:\/\/\//i.test(href)) href = href.slice(7);
        if (/^\/[a-z]:[\\/]/i.test(href)) href = href.slice(1);
        if (href.startsWith('//') || href.includes('?') || /^\/(?:api|vendor|images|videos|audio|downloads)\//.test(href)) return null;
        const suffix = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/.exec(href);
        const line = suffix ? Number(suffix[1] || suffix[2]) : null;
        let file = suffix ? href.slice(0, suffix.index) : href;
        try { if (!decoded) file = decodeURIComponent(file); } catch { return null; }
        const windowsDrive = /^[a-z]:[\\/]/i.test(file);
        if (windowsDrive || /^[a-z]:[\\/]/i.test(base)) { file = file.replace(/\\/g, '/'); base = base.replace(/\\/g, '/'); }
        if (!file || /[\x00-\x1f\x7f\\]/.test(file) || (!windowsDrive && /^(?:[a-z][\w+.-]*:|\/\/)/i.test(file)) || (windowsDrive && file.slice(2).includes(':')) || file.endsWith('/')
            || !/(?:\.[a-z\d_-]{1,16}|(?:^|\/)(?:README|LICENSE|Dockerfile|Makefile|CMakeLists\.txt))$/i.test(file)) return null;
        if (base && !file.startsWith('/') && !windowsDrive) file = `${base.slice(0, base.lastIndexOf('/') + 1)}${file}`;
        return { path: file, line: Number.isSafeInteger(line) && line > 0 ? line : null };
    }
    function markdown(text, base = '', preview = false) {
        if (!window.marked || !window.DOMPurify) return '';
        const renderer = new window.marked.Renderer(), original = renderer.link;
        const originalCode = renderer.code;
        renderer.code = function(token) {
            if (/^mermaid\s*$/i.test(token.lang || '')) {
                const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw || '');
                const closed = opening && new RegExp(`\\n {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(token.raw);
                return originalCode.call(this, { ...token, lang: closed ? 'mermaid' : 'mermaid-pending' });
            }
            return originalCode.call(this, token);
        };
        renderer.link = function(token) {
            const target = linkTarget(token.href, base);
            return original.call(this, target ? { ...token, href: `#pi-file=${encodeURIComponent(target.path + (target.line ? ':' + target.line : ''))}` } : token);
        };
        const math = window.PiMath?.create(renderer);
        const html = window.DOMPurify.sanitize(math ? math.parse(text) : window.marked.parse(text, { renderer }), {
            USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', ...(preview ? ['img', 'video', 'audio', 'source', 'object', 'embed'] : [])],
            FORBID_ATTR: ['style', 'onerror', 'onclick']
        });
        return math ? math.finish(html) : html;
    }

    class PiFileViewer {
        constructor(host) {
            this.host = host; this.sequence = 0; this.enabled = false; this.file = null; this.data = null;
            $('pi-file-diff-tab').addEventListener('click', () => this.show('diff'));
            $('pi-file-full-tab').addEventListener('click', () => this.show('full'));
            $('pi-file-source').addEventListener('change', () => { this.cancel(); this.source = $('pi-file-source').value; this.load(); });
            $('pi-file-refresh').addEventListener('click', () => { this.current = null; this.load(); });
            $('pi-file-preview').addEventListener('click', () => { this.preview = !this.preview; this.renderContent(); });
            $('pi-file-wrap').addEventListener('click', () => { this.wrap = !this.wrap; this.renderContent(); });
            $('pi-file-copy').addEventListener('click', async () => {
                if (!this.data) return;
                try { await host.copy(this.data.content); host.notify('已复制全文', 'success'); } catch (e) { host.notify(e.message, 'error'); }
            });
            $('pi-file-tabs').addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const tabs = [...$('pi-file-tabs').querySelectorAll('button')].filter(b => !b.disabled);
                const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(event.target) + 1) % tabs.length];
                next.click(); next.focus();
            });
            this.clear();
        }
        cancel() { this.sequence++; this.controller?.abort(); this.controller = null; this.loading = false; }
        clear() {
            this.cancel(); this.file = null; this.data = null; this.current = null;
            $('pi-file-tabs').hidden = true; $('pi-file-viewer').hidden = true; $('pi-file-body').replaceChildren();
        }
        setEnabled(enabled) { this.enabled = enabled; }
        setFile(file) {
            if (this.file?.identity === file.identity && this.file.path === file.path && this.file.hasDiff === file.hasDiff && this.file.writes.length === file.writes.length
                && this.file.writes.every((w, i) => w.id === file.writes[i].id && w.content === file.writes[i].content)) return;
            this.cancel(); this.file = file; this.data = null; this.current = null; this.jumped = false;
            this.preview = /\.(?:md|markdown)$/i.test(file.path) && !file.line; this.wrap = false;
            this.source = file.writes.length ? `write:${file.writes.at(-1).id}` : 'current';
            const picker = $('pi-file-source'); picker.replaceChildren();
            file.writes.forEach((w, i) => picker.append(new Option(`写入记录 ${i + 1}`, `write:${w.id}`)));
            picker.append(new Option('当前文件', 'current')); picker.value = this.source;
            $('pi-file-tabs').hidden = false; $('pi-file-diff-tab').disabled = !file.hasDiff;
            $('pi-file-path').textContent = file.path; $('pi-file-path').title = file.path;
            const prefix = this.host.context().cwd.replace(/\/$/, '') + '/';
            $('pi-changes-title').textContent = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
            $('pi-changes-title').title = file.path;
            $('pi-file-info').open = false;
            this.mode = null;
            this.show(file.hasDiff ? 'diff' : 'full');
        }
        show(mode) {
            if (!this.file) return;
            if (mode === 'diff') this.cancel();
            this.mode = mode;
            $('pi-file-source').closest('label').hidden = mode !== 'full';
            $('pi-changes-diffs').hidden = mode !== 'diff'; $('pi-file-viewer').hidden = mode !== 'full';
            for (const kind of ['diff', 'full']) {
                const tab = $(`pi-file-${kind}-tab`); tab.setAttribute('aria-selected', String(kind === mode)); tab.tabIndex = kind === mode ? 0 : -1;
            }
            if (mode === 'full') this.load();
        }
        status(text, error = false, progress = false) {
            $('pi-file-status').textContent = text; $('pi-file-status').dataset.error = String(error);
            const notice = $('pi-file-notice'); notice.textContent = text; notice.hidden = !error && !progress;
            notice.dataset.error = String(error);
        }
        controls() {
            $('pi-file-refresh').hidden = this.source !== 'current'; $('pi-file-refresh').disabled = this.loading || !this.enabled;
            $('pi-file-copy').disabled = !this.data || this.data.content.length === 0;
            $('pi-file-preview').hidden = !/\.(?:md|markdown)$/i.test(this.file?.path || '');
            $('pi-file-source').title = this.source === 'current' ? '当前磁盘文件快照，点击刷新更新' : '工具成功写入时的内容记录';
            $('pi-file-preview').disabled = !this.data; $('pi-file-preview').textContent = this.preview ? '源码' : '预览';
            $('pi-file-preview').title = this.preview ? '查看源码' : 'Markdown 排版预览';
            $('pi-file-preview').setAttribute('aria-label', $('pi-file-preview').title);
            $('pi-file-preview').setAttribute('aria-pressed', String(Boolean(this.preview)));
            $('pi-file-wrap').hidden = Boolean(this.preview); $('pi-file-wrap').disabled = !this.data;
            $('pi-file-wrap').setAttribute('aria-pressed', String(Boolean(this.wrap)));
        }
        async load() {
            if (!this.file || this.mode !== 'full') return;
            this.cancel(); this.data = null; $('pi-file-body').replaceChildren();
            if (window.PiFilePolicy.restricted(this.file.path)) { this.status('此文件不提供网页预览', true); this.controls(); return; }
            if (this.source !== 'current') {
                const write = this.file.writes.find(w => `write:${w.id}` === this.source);
                if (!write || new TextEncoder().encode(write.content).length > window.PiFilePolicy.maxBytes) { this.status('写入内容超过 2 MiB，暂不支持全文展示', true); this.controls(); return; }
                this.data = { content: write.content };
                this.status('本次成功写入的内容 · 不随磁盘后续修改而更新'); this.renderContent(); return;
            }
            if (!this.enabled) { this.status('当前后端尚未启用文件读取；写入记录仍可查看。', true); this.controls(); return; }
            if (this.current) { this.applyCurrent(); return; }
            const context = this.host.context(), sequence = this.sequence;
            this.controller = new AbortController(); this.loading = true; this.status('正在读取当前文件…', false, true); this.controls();
            try {
                const data = await this.host.api(`/api/pi/files/content?${new URLSearchParams({ cwd: context.cwd, path: this.file.path })}`, { signal: this.controller.signal });
                if (sequence !== this.sequence || context.key !== this.host.context().key || context.generation !== this.host.context().generation) return;
                if (typeof data.content !== 'string' || new TextEncoder().encode(data.content).length > window.PiFilePolicy.maxBytes) throw new Error('文件响应无效或超过大小限制');
                this.current = data; this.applyCurrent();
            } catch (error) { if (sequence === this.sequence && error.name !== 'AbortError') this.status(error.message || '文件读取失败', true); }
            finally {
                if (sequence === this.sequence) {
                    this.loading = false; this.controller = null;
                    if (context.key !== this.host.context().key || context.generation !== this.host.context().generation) this.status('会话连接已变化，请点击刷新重新读取', true);
                    this.controls();
                }
            }
        }
        applyCurrent() {
            this.data = this.current;
            const readAt = new Date(this.data.readAt), modifiedAt = new Date(this.data.modifiedAt);
            this.status(`当前文件快照${Number.isNaN(readAt.getTime()) ? '' : ` · 读取于 ${readAt.toLocaleTimeString()}`}，点击刷新更新${Number.isNaN(modifiedAt.getTime()) ? '' : ` · 文件修改于 ${modifiedAt.toLocaleString()}`}`);
            this.renderContent();
        }
        renderContent() {
            const body = $('pi-file-body'), oldTop = body.scrollTop;
            body.replaceChildren(); this.controls();
            if (!this.data) return;
            const text = this.data.content;
            if (!text.length) {
                const empty = document.createElement('p'); empty.className = 'pi-file-large-note'; empty.textContent = '空文件（0 字符）'; body.append(empty); return;
            }
            if (this.preview) {
                const article = document.createElement('article'); article.className = 'pi-markdown pi-file-markdown';
                article.innerHTML = markdown(text, this.data.absolutePath || this.file.path, true);
                for (const a of article.querySelectorAll('a')) {
                    const href = a.getAttribute('href') || '';
                    if (!href.startsWith('#pi-file=')) {
                        const target = linkTarget(href, this.data.absolutePath || this.file.path);
                        if (target) a.href = `#pi-file=${encodeURIComponent(target.path + (target.line ? ':' + target.line : ''))}`;
                    }
                    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
                }
                body.append(article);
            } else {
                const pre = document.createElement('pre'); pre.className = 'pi-file-code'; pre.classList.toggle('wrap', Boolean(this.wrap));
                const lines = text.split('\n');
                if (lines.length > 4000 || text.length > 500000) {
                    pre.textContent = text;
                    const note = document.createElement('p'); note.className = 'pi-file-large-note'; note.textContent = '大文件使用完整纯文本展示，暂不逐行高亮。'; body.append(note, pre);
                } else {
                    const extension = this.file.path.split('.').at(-1).toLowerCase(), language = languages[extension];
                    const fragment = document.createElement('div');
                    if (text.length <= 100000 && language && window.hljs?.getLanguage(language)) {
                        try { fragment.innerHTML = window.DOMPurify.sanitize(window.hljs.highlight(text, { language, ignoreIllegals: true }).value, { ALLOWED_TAGS: ['span'], ALLOWED_ATTR: ['class'] }); }
                        catch { fragment.textContent = text; }
                    } else fragment.textContent = text;
                    let number = 0, line;
                    const next = () => {
                        const row = document.createElement('span'); row.className = 'pi-file-line'; row.dataset.line = String(++number);
                        line = document.createElement('span'); line.className = 'pi-file-line-text'; row.append(line); pre.append(row);
                    };
                    next();
                    const visit = (node, classes = []) => {
                        if (node.nodeType === Node.TEXT_NODE) node.textContent.split('\n').forEach((part, i) => {
                            if (i) next();
                            if (!part) return;
                            const span = document.createElement('span'); span.className = classes.join(' '); span.textContent = part; line.append(span);
                        });
                        else for (const child of node.childNodes) visit(child, node.classList?.length ? [...classes, ...node.classList] : classes);
                    };
                    visit(fragment); body.append(pre);
                }
            }
            body.scrollTop = oldTop;
            if (this.file.line && !this.preview && !this.jumped) {
                const node = body.querySelector(`[data-line="${this.file.line}"]`);
                if (node) { node.classList.add('pi-file-target-line'); body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top - 12; }
                else body.scrollTop = (this.file.line - 1) * 20;
                this.jumped = true;
            }
        }
    }
    window.PiFileViewer = PiFileViewer;
    window.PiFileViewer.linkTarget = linkTarget;
    window.PiFileViewer.markdown = markdown;
})();
