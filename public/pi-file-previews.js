/* Bounded read-only previews. All content arrives through the verified file API. */
(() => {
    const tr = (zh, en, ...args) => {
        const template = globalThis.PiI18n?.locale?.startsWith('en') ? en : zh;
        return template.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? ''));
    };
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
    const button = (text, action) => { const b = node('button', text); b.type = 'button'; b.addEventListener('click', action); return b; };
    const note = (body, text) => body.append(node('p', text, 'pi-file-large-note'));
    // Parse quoted newlines/escaped quotes without evaluating formulas. Store only
    // a bounded prefix; the original text remains available in the source view.
    function parseTable(text, delimiter) {
        text = text.replace(/^\ufeff/, '');
        const rows = []; let row = [], cell = '', quoted = false, closed = false, partial = false, cells = 0;
        const pushCell = () => { if (row.length < 100) { row.push(cell); cells++; } else partial = true; cell = ''; closed = false; };
        const pushRow = () => { pushCell(); rows.push(row); row = []; };
        let i = 0;
        for (; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
                else cell += ch;
            } else if (ch === '"' && !cell && !closed) quoted = true;
            else if (ch === delimiter) pushCell();
            else if (ch === '\r' || ch === '\n') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                pushRow();
                if (rows.length >= 5000 || cells >= 50000) { partial ||= i < text.length - 1; i++; break; }
            } else {
                if (closed || ch === '"') throw new Error(tr('表格引号格式无效，请切换源码查看', 'Invalid table quoting; switch to source view'));
                cell += ch;
            }
            if (cell.length > 32768) throw new Error(tr('单元格过长，请切换源码查看', 'Cell exceeds the preview limit; switch to source view'));
        }
        if (quoted) throw new Error(tr('表格引号未闭合，请切换源码查看', 'Unclosed table quote; switch to source view'));
        if (i >= text.length && (cell || closed || row.length)) pushRow();
        return { rows, partial };
    }
    function table(body, data, context) {
        const { rows, partial } = parseTable(data.content, data.delimiter === '\t' ? '\t' : ',');
        if (!rows.length) { note(body, tr('空表格', 'Empty table')); return; }
        let page = Math.max(0, Math.min(Math.floor((rows.length - 1) / 50), context.state.tablePage || 0));
        const toolbar = node('div', undefined, 'pi-file-preview-toolbar'), label = node('span');
        const viewport = node('div', undefined, 'pi-file-table-scroll');
        const previous = button(tr('上一页', 'Previous'), () => { page--; render(); });
        const next = button(tr('下一页', 'Next'), () => { page++; render(); });
        toolbar.append(previous, label, next); body.append(toolbar);
        if (partial) note(body, tr('仅预览前 5000 行、100 列及约 50000 个单元格；完整内容请切换源码或下载。', 'Preview is limited to 5,000 rows, 100 columns and about 50,000 cells. Use source or download for the full content.'));
        body.append(viewport);
        function render() {
            context.state.tablePage = page;
            const start = page * 50, end = Math.min(start + 50, rows.length), t = node('table');
            t.className = 'pi-file-data-table'; t.setAttribute('aria-label', tr('文件表格', 'File table'));
            const tbody = node('tbody');
            rows.slice(start, end).forEach((values, index) => {
                const row = node('tr'), number = node('th', String(start + index + 1)); number.scope = 'row'; row.append(number);
                values.forEach(value => row.append(node('td', value))); tbody.append(row);
            });
            t.append(tbody); viewport.replaceChildren(t); viewport.scrollTop = 0; viewport.scrollLeft = 0;
            label.textContent = tr('{0}–{1} / {2} 行', 'Rows {0}–{1} / {2}', start + 1, end, rows.length);
            previous.disabled = page === 0; next.disabled = end >= rows.length;
        }
        render();
    }
    function imageViewer(body, url, context) {
        const state = context.state.image ||= { mode: 'fit', scale: 1, x: 0, y: 0 };
        let disposed = false, moved = false, startPoint, loaded = false;
        const wrap = node('div', undefined, 'pi-file-image has-image-controls');
        const toolbar = node('div', undefined, 'pi-file-preview-toolbar'), percent = node('span');
        const viewport = node('div', undefined, 'pi-file-image-viewport'); viewport.tabIndex = 0;
        viewport.setAttribute('aria-label', tr('图片查看器，可拖动或使用方向键移动，滚轮或双指缩放', 'Image viewer: drag or use arrow keys to pan; scroll or pinch to zoom'));
        const image = node('img'); image.alt = context.name; image.draggable = false;
        image.setAttribute('role', 'button'); image.tabIndex = 0;
        image.setAttribute('aria-label', tr('全屏查看 {0}', 'View {0} full screen', context.name));
        const fit = button(tr('适应窗口', 'Fit window'), () => setMode('fit'));
        const minus = button('−', () => zoom(1 / 1.25)); minus.setAttribute('aria-label', tr('缩小图片', 'Zoom image out'));
        const plus = button('+', () => zoom(1.25)); plus.setAttribute('aria-label', tr('放大图片', 'Zoom image in'));
        toolbar.append(minus, percent, plus, fit); viewport.append(image); wrap.append(toolbar, viewport); body.append(wrap);
        const pointers = new Map(), events = new AbortController();
        const clamp = (value, limit) => Math.max(-limit, Math.min(limit, value));
        const offsets = () => ({ x: clamp(state.x, Math.max(0, (image.naturalWidth * state.scale - viewport.clientWidth) / 2)),
            y: clamp(state.y, Math.max(0, (image.naturalHeight * state.scale - viewport.clientHeight) / 2)) });
        function draw() {
            if (disposed || !loaded) return;
            if (state.mode === 'fit') state.scale = Math.min(1, Math.max(1, viewport.clientWidth - 24) / image.naturalWidth, Math.max(1, viewport.clientHeight - 24) / image.naturalHeight);
            else if (state.mode === 'actual') state.scale = 1;
            const { x, y } = offsets();
            image.style.width = image.naturalWidth + 'px'; image.style.height = image.naturalHeight + 'px';
            image.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${state.scale})`;
            percent.textContent = Math.round(state.scale * 100) + '%';
            wrap.classList.toggle('actual-size', state.mode === 'actual');
            context.imageChanged?.(state.mode);
        }
        function setMode(mode) { state.mode = mode; state.x = state.y = 0; draw(); }
        function zoom(factor, cx = 0, cy = 0) {
            if (!loaded || disposed) return;
            const oldScale = state.scale, next = Math.max(.01, Math.min(8, oldScale * factor)), position = offsets();
            state.mode = 'custom'; state.scale = next;
            state.x = cx - (cx - position.x) * next / oldScale; state.y = cy - (cy - position.y) * next / oldScale;
            draw();
        }
        const on = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: events.signal });
        on(image, 'load', () => { loaded = true; draw(); });
        on(image, 'error', () => { if (!disposed) note(body, tr('图片无法解码，可下载原文件', 'Image cannot be decoded; download the original')); });
        on(image, 'dragstart', e => e.preventDefault());
        on(viewport, 'click', () => { if (!moved && !context.isFullscreen?.()) context.openFullscreen?.(); });
        on(viewport, 'keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); context.openFullscreen?.(); return; }
            if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoom(event.key === '-' ? 1 / 1.25 : 1.25); }
            else if (event.key === '0' || event.key === '1') { event.preventDefault(); setMode(event.key === '0' ? 'fit' : 'actual'); }
            else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
                event.preventDefault(); const position = offsets();
                state.x = position.x + (event.key === 'ArrowLeft' ? 40 : event.key === 'ArrowRight' ? -40 : 0);
                state.y = position.y + (event.key === 'ArrowUp' ? 40 : event.key === 'ArrowDown' ? -40 : 0); draw();
            }
        });
        on(viewport, 'wheel', event => {
            if (!loaded) return; event.preventDefault(); const rect = viewport.getBoundingClientRect();
            zoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * .005), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
        }, { passive: false });
        const geometry = () => {
            const points = [...pointers.values()], a = points[0], b = points[1] || a;
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(a.x - b.x, a.y - b.y) };
        };
        on(viewport, 'pointerdown', event => {
            if (!loaded || event.button !== 0) return;
            if (!pointers.size) { moved = false; startPoint = { x: event.clientX, y: event.clientY }; }
            pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); viewport.setPointerCapture(event.pointerId);
            if (pointers.size > 1) moved = true;
        });
        on(viewport, 'pointermove', event => {
            if (!pointers.has(event.pointerId)) return;
            const before = geometry(); pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); const after = geometry();
            moved ||= Math.hypot(event.clientX - startPoint.x, event.clientY - startPoint.y) > 4;
            if (!moved) return; event.preventDefault();
            if (pointers.size > 1 && before.distance > 0) {
                const rect = viewport.getBoundingClientRect(); zoom(after.distance / before.distance, before.x - rect.left - rect.width / 2, before.y - rect.top - rect.height / 2);
            }
            const position = offsets(); state.x = position.x + after.x - before.x; state.y = position.y + after.y - before.y; draw();
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) on(viewport, type, event => {
            pointers.delete(event.pointerId); if (type === 'pointercancel') moved = true;
        });
        const observer = new ResizeObserver(draw); observer.observe(viewport);
        image.src = url;
        const dispose = () => { disposed = true; observer.disconnect(); events.abort(); pointers.clear(); image.removeAttribute('src'); };
        dispose.toggleSize = () => setMode(state.mode === 'actual' ? 'fit' : 'actual');
        dispose.resize = draw;
        return dispose;
    }
    function svg(body, data, context) {
        const text = data.content;
        if (text.length > 512 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error(tr('SVG 超过预览限制或包含不支持的声明，可查看源码或下载', 'SVG exceeds preview limits or contains unsupported declarations; use source or download'));
        const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = parsed.documentElement;
        if (parsed.querySelector('parsererror') || root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg' || parsed.querySelectorAll('*').length > 10000)
            throw new Error(tr('SVG 格式无效或图形过于复杂，可查看源码或下载', 'Invalid or overly complex SVG; use source or download'));
        // Render as an image (never inline DOM). Remove active and externally
        // referenced content as an additional boundary before image decoding.
        const clean = window.DOMPurify.sanitize(text, {
            USE_PROFILES: { svg: true, svgFilters: true }, RETURN_DOM: true,
            FORBID_TAGS: ['script', 'foreignObject', 'style', 'image', 'a', 'animate', 'animateMotion', 'animateTransform', 'set', 'filter', 'feImage'],
            FORBID_ATTR: ['style', 'xml:base']
        });
        const sanitized = clean.querySelector('svg');
        if (!sanitized) throw new Error(tr('SVG 无法预览', 'SVG cannot be previewed'));
        for (const el of [sanitized, ...sanitized.querySelectorAll('*')]) {
            for (const attr of [...el.attributes]) {
                if (/^on/i.test(attr.name) || attr.value.length > 65536 || /^(?:href|xlink:href)$/i.test(attr.name) && !/^#[\w.:-]+$/.test(attr.value)
                    || /url\s*\(/i.test(attr.value) && !/^url\(\s*['"]?#[\w.:-]+['"]?\s*\)$/i.test(attr.value)) el.removeAttribute(attr.name);
            }
        }
        const viewBox = (sanitized.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
        const width = parseFloat(sanitized.getAttribute('width')) || viewBox[2] || 800;
        const height = parseFloat(sanitized.getAttribute('height')) || viewBox[3] || 600;
        if (![width, height].every(n => Number.isFinite(n) && n > 0 && n <= 16384) || width * height > 32 * 1024 * 1024)
            throw new Error(tr('SVG 尺寸超过预览限制，可查看源码或下载', 'SVG dimensions exceed preview limits; use source or download'));
        sanitized.setAttribute('width', String(width)); sanitized.setAttribute('height', String(height));
        return imageViewer(body, context.blob(new XMLSerializer().serializeToString(sanitized), 'image/svg+xml'), context);
    }
    function audio(body, data, context) {
        const player = node('audio'); player.controls = true; player.preload = 'metadata'; player.className = 'pi-file-audio';
        player.setAttribute('aria-label', context.name); player.src = context.blob(context.bytes(), data.mime);
        player.addEventListener('error', () => note(body, tr('浏览器无法播放此音频编码，可下载原文件', 'This audio codec cannot be played in your browser; download the original')), { once: true });
        body.append(player);
        return () => { player.pause(); player.removeAttribute('src'); player.load(); };
    }
    let pdfLibrary;
    function pdf(body, data, context) {
        const state = context.state.pdf ||= { page: 1, scale: 1, textOpen: false };
        let disposed = false, loading, documentProxy, renderTask, currentPage, generation = 0, pageNumber = state.page, scale = state.scale, timer, resizeTimer, pendingAnchor;
        let lastWidth = body.clientWidth;
        const captureView = () => ({ x: body.scrollLeft / (canvas.clientWidth || 1), y: body.scrollTop / (canvas.clientHeight || 1) });
        const resize = anchor => {
            if (disposed) return;
            if (anchor) pendingAnchor = anchor;
            clearTimeout(resizeTimer); resizeTimer = setTimeout(() => {
                const view = pendingAnchor || captureView(); pendingAnchor = null;
                if (!disposed && documentProxy) void show(pageNumber, view);
            }, 80);
        };
        const observer = new ResizeObserver(() => { if (body.clientWidth !== lastWidth) { lastWidth = body.clientWidth; resize(); } }); observer.observe(body);
        const toolbar = node('div', undefined, 'pi-file-preview-toolbar'), status = node('span', tr('正在加载 PDF…', 'Loading PDF…'));
        const canvas = node('canvas'), paper = node('div', undefined, 'pi-file-pdf-paper'); paper.append(canvas);
        const textView = node('details', undefined, 'pi-file-pdf-text'), text = node('pre');
        textView.append(node('summary', tr('本页文字', 'Page text')), text);
        textView.open = state.textOpen; textView.addEventListener('toggle', () => { if (!disposed) state.textOpen = textView.open; });
        const input = node('input'); input.type = 'number'; input.min = '1'; input.value = '1'; input.setAttribute('aria-label', tr('页码', 'Page number'));
        const previous = button(tr('上一页', 'Previous'), () => show(pageNumber - 1));
        const next = button(tr('下一页', 'Next'), () => show(pageNumber + 1));
        const smaller = button('−', () => { scale = Math.max(.5, scale / 1.25); show(pageNumber, captureView()); }); smaller.setAttribute('aria-label', tr('缩小', 'Zoom out'));
        const larger = button('+', () => { scale = Math.min(3, scale * 1.25); show(pageNumber, captureView()); }); larger.setAttribute('aria-label', tr('放大', 'Zoom in'));
        const fit = button(tr('适应宽度', 'Fit width'), () => { scale = 1; show(pageNumber, captureView()); });
        input.addEventListener('change', () => show(Number(input.value)));
        toolbar.append(previous, input, next, smaller, larger, fit); body.append(toolbar, status, paper, textView);
        status.className = 'pi-file-large-note';
        const controls = [previous, input, next, smaller, larger, fit]; controls.forEach(n => n.disabled = true);
        function dispose() {
            if (disposed) return;
            disposed = true; generation++; clearTimeout(timer); clearTimeout(resizeTimer); observer.disconnect(); renderTask?.cancel();
            if (loading) Promise.resolve(loading.destroy()).catch(() => {});
            canvas.width = canvas.height = 0;
        }
        function failure(error) {
            if (disposed || error?.name === 'RenderingCancelledException') return;
            status.textContent = error?.name === 'PasswordException' ? tr('此 PDF 需要密码，请下载后打开', 'This PDF requires a password; download to open it') : tr('PDF 无法预览，可下载原文件', 'PDF cannot be previewed; download the original');
            controls.forEach(n => n.disabled = true); dispose();
        }
        async function show(requested, anchor = null) {
            if (disposed || !documentProxy) return;
            const ticket = ++generation;
            clearTimeout(timer); timer = setTimeout(() => failure(new Error('PDF page timeout')), 30000);
            pageNumber = Math.max(1, Math.min(documentProxy.numPages, Number.isFinite(requested) ? Math.trunc(requested) : 1));
            state.page = pageNumber; state.scale = scale;
            input.value = String(pageNumber); previous.disabled = pageNumber === 1; next.disabled = pageNumber === documentProxy.numPages;
            const oldTask = renderTask; oldTask?.cancel();
            if (!anchor) { text.textContent = ''; textView.open = false; state.textOpen = false; }
            try {
                if (oldTask) await oldTask.promise.catch(() => {});
                if (disposed || ticket !== generation) return;
                currentPage?.cleanup(); currentPage = null;
                const page = await documentProxy.getPage(pageNumber);
                if (disposed || ticket !== generation) return;
                currentPage = page;
                const natural = page.getViewport({ scale: 1 });
                if (!Number.isFinite(natural.width * natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error('Invalid page size');
                const zoom = Math.min((Math.max(200, body.clientWidth - 24) / natural.width) * scale, 4096 / natural.width, 4096 / natural.height,
                    Math.sqrt(4 * 1024 * 1024 / (natural.width * natural.height)));
                const viewport = page.getViewport({ scale: zoom });
                const ratio = Math.min(devicePixelRatio || 1, 2, 4096 / viewport.width, 4096 / viewport.height, Math.sqrt(4 * 1024 * 1024 / (viewport.width * viewport.height)));
                const renderViewport = page.getViewport({ scale: zoom * ratio });
                canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
                canvas.width = Math.ceil(renderViewport.width); canvas.height = Math.ceil(renderViewport.height);
                renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport: renderViewport });
                await renderTask.promise;
                if (disposed || ticket !== generation) return;
                body.scrollLeft = (anchor?.x || 0) * canvas.clientWidth; body.scrollTop = (anchor?.y || 0) * canvas.clientHeight;
                status.textContent = tr('第 {0} / {1} 页', 'Page {0} / {1}', pageNumber, documentProxy.numPages);
                // Stream bounded text; do not retain every page or all text items.
                const reader = page.streamTextContent().getReader(); let content = '';
                try {
                    while (content.length < 100000 && !disposed && ticket === generation) {
                        const result = await reader.read(); if (result.done) break;
                        for (const item of result.value.items) {
                            if (typeof item.str === 'string') content += (item.str + (item.hasEOL ? '\n' : ' ')).slice(0, 100000 - content.length);
                            if (content.length >= 100000) break;
                        }
                    }
                } finally { await reader.cancel().catch(() => {}); }
                if (!disposed && ticket === generation) { clearTimeout(timer); text.textContent = content.slice(0, 100000) || tr('此页没有可提取文字（扫描页不自动 OCR）', 'No extractable text on this page (scans are not automatically OCRed)'); }
            } catch (error) { if (ticket === generation) failure(error); }
        }
        timer = setTimeout(() => failure(new Error('PDF load timeout')), 30000);
        (async () => {
            pdfLibrary ||= import('/vendor/pdfjs/legacy/build/pdf.mjs').catch(error => { pdfLibrary = null; throw error; });
            const lib = await pdfLibrary; if (disposed) return;
            lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/legacy/build/pdf.worker.mjs';
            loading = lib.getDocument({ data: context.bytes(), isEvalSupported: false, enableXfa: false, disableAutoFetch: true,
                cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', wasmUrl: '/vendor/pdfjs/wasm/',
                maxImageSize: 16 * 1024 * 1024, canvasMaxAreaInBytes: 16 * 1024 * 1024 });
            documentProxy = await loading.promise; clearTimeout(timer); if (disposed) return;
            controls.forEach(n => n.disabled = false); input.max = String(documentProxy.numPages); await show(state.page, { x: 0, y: 0 });
        })().catch(failure);
        dispose.captureView = captureView; dispose.resize = resize;
        return dispose;
    }
    function render(body, data, context) {
        try {
            if (data.kind === 'table') table(body, data, context);
            else if (data.kind === 'image') return imageViewer(body, context.blob(context.bytes(), data.mime), context);
            else if (data.kind === 'svg') return svg(body, data, context);
            else if (data.kind === 'audio') return audio(body, data, context);
            else if (data.kind === 'pdf') return pdf(body, data, context);
        } catch (error) { note(body, error.message); }
        return () => {};
    }
    window.PiFilePreviews = { render, parseTable };
})();
