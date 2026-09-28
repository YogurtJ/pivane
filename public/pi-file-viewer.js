(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const languages = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', json: 'json', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', sql: 'sql', rb: 'ruby', php: 'php', ini: 'ini', toml: 'ini', diff: 'diff' };
    function linkTarget(href, base = '') {
        if (typeof href !== 'string' || !href) return null;
        const delivery = /^#pi-delivery=([a-f0-9]{64})\/(\d{1,2})$/.exec(href);
        if (delivery && Number(delivery[2]) < 20) return { deliveryId: delivery[1], index: Number(delivery[2]) };
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
            return original.call(this, target && !target.deliveryId ? { ...token, href: `#pi-file=${encodeURIComponent(target.path + (target.line ? ':' + target.line : ''))}` } : token);
        };
        const math = window.PiMath?.create(renderer);
        const source = text.replace(/^\uFEFF/, ''); // BOM belongs to the downloadable bytes, not the first heading.
        const html = window.DOMPurify.sanitize(math ? math.parse(source) : window.marked.parse(source, { renderer }), {
            USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', ...(preview ? ['img', 'video', 'audio', 'source', 'object', 'embed'] : [])],
            FORBID_ATTR: ['style', 'onerror', 'onclick']
        });
        return math ? math.finish(html) : html;
    }

    class PiFileViewer {
        constructor(host) {
            this.host = host; this.sequence = 0; this.enabled = false; this.file = null; this.data = null;
            this.previewsEnabled = false; this.deliverablesEnabled = false; this.objectUrls = [];
            const action = (id, title, run) => { const b = document.createElement('button'); b.id = id; b.type = 'button'; b.textContent = title; b.addEventListener('click', run); $('pi-file-info').before(b); return b; };
            this.downloadButton = action('pi-file-download', translateUi('下载'), () => this.download());
            this.imageSizeButton = action('pi-file-image-size', translateUi('原尺寸'), () => { this.actualSize = !this.actualSize; this.renderContent(); });
            this.runButton = action('pi-file-run-html', translateUi('运行交互'), () => { this.runHtml = !this.runHtml; this.renderContent(); });
            $('pi-file-diff-tab').addEventListener('click', () => this.show('diff'));
            $('pi-file-full-tab').addEventListener('click', () => this.show('full'));
            $('pi-file-source').addEventListener('change', () => { this.cancel(); this.source = $('pi-file-source').value; this.load(); });
            $('pi-file-refresh').addEventListener('click', () => { this.current = null; this.load(); });
            $('pi-file-preview').addEventListener('click', () => { this.preview = !this.preview; this.renderContent(); });
            $('pi-file-wrap').addEventListener('click', () => { this.wrap = !this.wrap; this.renderContent(); });
            $('pi-file-copy').addEventListener('click', async () => {
                if (!this.data) return;
                try { await host.copy(this.data.content); host.notify(translateUi("已复制全文"), 'success'); } catch (e) { host.notify(e.message, 'error'); }
            });
            $('pi-file-tabs').addEventListener('keydown', event => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const tabs = [...$('pi-file-tabs').querySelectorAll('button')].filter(b => !b.disabled);
                const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : tabs[(tabs.indexOf(event.target) + 1) % tabs.length];
                next.click(); next.focus();
            });
            this.clear();
            new MutationObserver(() => {
                const pane = $('pi-inspector');
                if (this.runHtml && (!pane.classList.contains('open') || !pane.classList.contains('show-changes'))) this.stopInteractive();
            }).observe($('pi-inspector'), { attributes: true, attributeFilter: ['class'] });
        }
        stopInteractive() { if (this.runHtml) { this.runHtml = false; this.renderContent(); } }
        cancel() { this.sequence++; this.controller?.abort(); this.controller = null; this.loading = false; }
        releaseUrls() { this.objectUrls.forEach(url => URL.revokeObjectURL(url)); this.objectUrls = []; }
        blob(bytes, mime) { const url = URL.createObjectURL(new Blob([bytes], { type: mime })); this.objectUrls.push(url); return url; }
        bytes() { return this.data?.encoding === 'base64' ? Uint8Array.from(atob(this.data.base64), c => c.charCodeAt(0)) : new TextEncoder().encode(this.data?.content || ''); }
        download() {
            if (!this.data) return;
            const url = URL.createObjectURL(new Blob([this.bytes()], { type: 'application/octet-stream' }));
            const link = document.createElement('a'); link.href = url; link.download = this.data.name || this.file.path.split(/[\\/]/).at(-1) || 'download';
            document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        clear() {
            this.cancel(); this.releaseUrls(); this.file = null; this.data = null; this.current = null; this.positions = new Map(); this.restoreTop = null;
            this.runHtml = false; this.actualSize = false;
            $('pi-file-tabs').hidden = true; $('pi-file-viewer').hidden = true; $('pi-file-body').replaceChildren();
        }
        setEnabled(enabled) { this.enabled = enabled; }
        rememberPosition() {
            if (this.file && this.data && $('pi-file-body').getClientRects().length) {
                this.positions.set(this.file.identity, { top: $('pi-file-body').scrollTop, preview: this.preview, wrap: this.wrap });
                if (this.positions.size > 40) this.positions.delete(this.positions.keys().next().value);
            }
        }
        restorePosition() {
            const saved = this.positions.get(this.file?.identity);
            if (saved && this.data) $('pi-file-body').scrollTop = saved.top;
        }
        setFile(file) {
            if (this.file?.identity === file.identity && (this.file.path === file.path || this.file.deliveryId && this.file.deliveryId === file.deliveryId) && this.file.hasDiff === file.hasDiff && this.file.writes.length === file.writes.length
                && this.file.writes.every((w, i) => w.id === file.writes[i].id && w.content === file.writes[i].content)) return;
            this.rememberPosition();
            this.cancel(); this.releaseUrls(); this.file = file; this.data = null; this.current = null; this.jumped = false;
            this.runHtml = false; this.actualSize = false;
            const position = this.positions.get(file.identity);
            this.defaultPreview = !position && !file.line;
            this.restoreTop = position?.top || 0;
            this.preview = position?.preview ?? (/\.(?:md|markdown)$/i.test(file.path) && !file.line); this.wrap = position?.wrap || false;
            this.source = file.writes.length ? `write:${file.writes.at(-1).id}` : 'current';
            const picker = $('pi-file-source'); picker.replaceChildren();
            file.writes.forEach((w, i) => picker.append(new Option(translateUi("写入记录 {0}", i + 1), `write:${w.id}`)));
            picker.append(new Option(file.deliveryId ? translateUi('交付快照') : translateUi("当前文件"), 'current')); picker.value = this.source;
            $('pi-file-tabs').hidden = false; $('pi-file-diff-tab').disabled = !file.hasDiff;
            $('pi-file-path').textContent = file.path; $('pi-file-path').title = file.path;
            const prefix = this.host.context().cwd.replace(/\/$/, '') + '/';
            $('pi-changes-title').textContent = file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path;
            $('pi-changes-title').title = file.path;
            $('pi-file-info').open = false;
            this.mode = null;
            this.show(file.hasDiff ? 'diff' : 'full');
            this.host.selected?.(file);
        }
        show(mode) {
            if (!this.file) return;
            if (mode === 'diff') { this.cancel(); this.releaseUrls(); $('pi-file-body').replaceChildren(); this.runHtml = false; }
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
            const kind = this.data?.kind || (/\.(?:md|markdown)$/i.test(this.file?.path || '') ? 'markdown' : 'text');
            $('pi-file-refresh').hidden = this.source !== 'current'; $('pi-file-refresh').disabled = this.loading || !this.enabled;
            $('pi-file-copy').disabled = !this.data?.content?.length;
            $('pi-file-preview').hidden = !['markdown', 'html'].includes(kind);
            this.downloadButton.hidden = !this.previewsEnabled && !this.file?.deliveryId;
            this.downloadButton.disabled = !this.data;
            this.imageSizeButton.hidden = kind !== 'image'; this.imageSizeButton.textContent = this.actualSize ? translateUi('适应窗口') : translateUi('原尺寸');
            this.runButton.hidden = kind !== 'html' || !this.preview;
            this.runButton.disabled = !this.data; this.runButton.setAttribute('aria-pressed', String(Boolean(this.runHtml)));
            this.runButton.textContent = this.runHtml ? translateUi('停止交互') : translateUi('运行交互');
            $('pi-file-source').title = this.file?.deliveryId ? translateUi('交付时保存的只读版本，不随源文件变化') : this.source === 'current' ? translateUi("当前磁盘文件快照，点击刷新更新") : translateUi("工具成功写入时的内容记录");
            $('pi-file-preview').disabled = !this.data; $('pi-file-preview').textContent = this.preview ? translateUi("源码") : translateUi("预览");
            $('pi-file-preview').title = this.preview ? translateUi("查看源码") : translateUi("预览");
            $('pi-file-preview').setAttribute('aria-label', $('pi-file-preview').title);
            $('pi-file-preview').setAttribute('aria-pressed', String(Boolean(this.preview)));
            $('pi-file-wrap').hidden = Boolean(this.preview) || ['image', 'binary'].includes(kind); $('pi-file-wrap').disabled = !this.data;
            $('pi-file-wrap').setAttribute('aria-pressed', String(Boolean(this.wrap)));
        }
        async load() {
            if (!this.file || this.mode !== 'full') return;
            this.cancel(); this.releaseUrls(); this.runHtml = false; this.data = null; $('pi-file-body').replaceChildren();
            if (!this.file.deliveryId && window.PiFilePolicy.restricted(this.file.path)) { this.status(translateUi("此文件不提供网页预览"), true); this.controls(); return; }
            if (this.source !== 'current') {
                const write = this.file.writes.find(w => `write:${w.id}` === this.source);
                if (!write || new TextEncoder().encode(write.content).length > window.PiFilePolicy.maxBytes) { this.status(translateUi("写入内容超过 2 MiB，暂不支持全文展示"), true); this.controls(); return; }
                this.data = { content: write.content, kind: /\.(?:html?|md|markdown)$/i.test(this.file.path) ? /\.html?$/i.test(this.file.path) && this.previewsEnabled ? 'html' : /\.(md|markdown)$/i.test(this.file.path) ? 'markdown' : 'text' : 'text' };
                if (this.defaultPreview) { this.preview = ['markdown', 'html'].includes(this.data.kind); this.defaultPreview = false; }
                this.status(translateUi("本次成功写入的内容 · 不随磁盘后续修改而更新")); this.renderContent(); return;
            }
            if (!this.enabled) { this.status(translateUi("当前后端尚未启用文件读取；写入记录仍可查看。"), true); this.controls(); return; }
            if (this.current) { this.applyCurrent(); return; }
            const context = this.host.context(), sequence = this.sequence;
            this.controller = new AbortController(); this.loading = true; this.status(translateUi("正在读取当前文件…"), false, true); this.controls();
            try {
                const query = this.file.deliveryId ? new URLSearchParams({ cwd: context.cwd, sessionId: context.sessionId || '', id: this.file.deliveryId, index: this.file.index }) : new URLSearchParams({ cwd: context.cwd, path: this.file.path });
                const endpoint = this.file.deliveryId ? 'deliverables' : `files/${this.previewsEnabled ? 'preview' : 'content'}`;
                const data = await this.host.api(`/api/pi/${endpoint}?${query}`, { signal: this.controller.signal });
                if (sequence !== this.sequence || context.key !== this.host.context().key || context.generation !== this.host.context().generation) return;
                const binary = data.encoding === 'base64';
                if (binary ? typeof data.base64 !== 'string' || data.base64.length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64) || data.base64.length % 4 !== 0
                    : typeof data.content !== 'string' || new TextEncoder().encode(data.content).length > window.PiFilePolicy.maxBytes) throw new Error(translateUi("文件响应无效或超过大小限制"));
                this.current = data; this.applyCurrent();
            } catch (error) {
                if (sequence === this.sequence && error.name !== 'AbortError') {
                    const outside = error.data?.code === 'FILE_OUTSIDE';
                    this.status(outside ? translateUi('文件位于当前项目外。请让 Agent 使用 deliver_files 登记为交付物；不会自动扩大访问范围。') : error.message || translateUi("文件读取失败"), true);
                }
            }
            finally {
                if (sequence === this.sequence) {
                    this.loading = false; this.controller = null;
                    if (context.key !== this.host.context().key || context.generation !== this.host.context().generation) this.status(translateUi("会话连接已变化，请点击刷新重新读取"), true);
                    this.controls();
                }
            }
        }
        applyCurrent() {
            this.data = this.current;
            const readAt = new Date(this.data.readAt), modifiedAt = new Date(this.data.modifiedAt);
            this.status(this.file.deliveryId ? translateUi('交付快照 · {0} · SHA256 {1}', new Date(this.data.createdAt).toLocaleString(globalThis.PiI18n?.locale), this.data.revision)
                : translateUi("当前文件快照{0}，点击刷新更新{1}", Number.isNaN(readAt.getTime()) ? '' : translateUi(" · 读取于 {0}", readAt.toLocaleTimeString(globalThis.PiI18n?.locale)), Number.isNaN(modifiedAt.getTime()) ? '' : translateUi(" · 文件修改于 {0}", modifiedAt.toLocaleString(globalThis.PiI18n?.locale))));
            if (this.file.deliveryId && this.data.name) { this.file.path = this.data.name; $('pi-changes-title').textContent = this.data.name; $('pi-file-path').textContent = this.data.absolutePath; this.host.selected?.(this.file); }
            if (this.defaultPreview && this.data.kind) { this.preview = ['markdown', 'html', 'image'].includes(this.data.kind); this.defaultPreview = false; }
            this.renderContent();
        }
        renderContent() {
            const body = $('pi-file-body'), oldTop = body.scrollTop;
            this.releaseUrls(); body.replaceChildren(); this.controls();
            if (!this.data) return;
            if (this.data.kind === 'image') {
                const wrap = document.createElement('div'); wrap.className = 'pi-file-image'; wrap.classList.toggle('actual-size', Boolean(this.actualSize));
                const image = document.createElement('img'); image.alt = this.data.name || this.file.path; image.src = this.blob(this.bytes(), this.data.mime);
                image.addEventListener('error', () => this.status(translateUi('图片无法解码，可下载原文件'), true), { once: true });
                wrap.append(image); body.append(wrap); return;
            }
            if (this.data.kind === 'binary') { const note = document.createElement('p'); note.className = 'pi-file-large-note'; note.textContent = translateUi(this.data.previewReason || '此类型暂不支持预览，可下载原文件'); body.append(note); return; }
            const text = this.data.content;
            if (!text.length) {
                const empty = document.createElement('p'); empty.className = 'pi-file-large-note'; empty.textContent = translateUi("空文件（0 字符）"); body.append(empty); return;
            }
            if (this.preview && this.data.kind === 'html') {
                const note = document.createElement('p'); note.className = 'pi-file-preview-warning';
                note.textContent = this.runHtml ? translateUi('隔离交互已运行；无法访问工作台。仅运行可信页面，脚本导航仍可能联网。') : translateUi('静态预览 · 脚本尚未运行。仅对可信页面启用交互；相对资源不自动加载。');
                const frame = document.createElement('iframe'); frame.className = 'pi-file-html'; frame.title = translateUi('HTML 隔离预览');
                frame.setAttribute('sandbox', this.runHtml ? 'allow-scripts' : ''); frame.referrerPolicy = 'no-referrer'; frame.setAttribute('credentialless', '');
                frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; fullscreen 'none'");
                const csp = `default-src 'none'; script-src ${this.runHtml ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
                const template = document.createElement('template'); template.innerHTML = text;
                // Static previews must not navigate via refresh/base. Scripts, when
                // explicitly enabled, remain confined to the opaque iframe.
                template.content.querySelectorAll('base, meta[http-equiv], iframe, object, embed').forEach(n => n.remove());
                frame.srcdoc = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + csp + '">' + template.innerHTML;
                body.append(note, frame); return;
            }
            if (this.preview) {
                const article = document.createElement('article'); article.className = 'pi-markdown pi-file-markdown';
                article.innerHTML = markdown(text, this.data.absolutePath || this.file.path, true);
                for (const a of article.querySelectorAll('a')) {
                    const href = a.getAttribute('href') || '';
                    if (!href.startsWith('#pi-file=')) {
                        const target = linkTarget(href, this.data.absolutePath || this.file.path);
                        if (target && !target.deliveryId) a.href = `#pi-file=${encodeURIComponent(target.path + (target.line ? ':' + target.line : ''))}`;
                    }
                    if (/^https?:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
                }
                body.append(article);
            } else {
                const pre = document.createElement('pre'); pre.className = 'pi-file-code'; pre.classList.toggle('wrap', Boolean(this.wrap));
                const lines = text.split('\n');
                if (lines.length > 4000 || text.length > 500000) {
                    pre.textContent = text;
                    const note = document.createElement('p'); note.className = 'pi-file-large-note'; note.textContent = translateUi("大文件使用完整纯文本展示，暂不逐行高亮。"); body.append(note, pre);
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
            body.scrollTop = this.restoreTop ?? oldTop; this.restoreTop = null;
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
