(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const selector = '.pi-markdown pre > code.language-mermaid';
    const records = new WeakMap();
    let frame, ready, pending, serial = 0, scanning = false, running = false;
    const queue = new Set();
    // Bounded, page-only layout cache; no history or browser storage.
    const cache = new Map();
    let cacheBytes = 0;
    const dark = () => document.documentElement.dataset.theme === 'dark';

    function resetFrame() {
        frame?.remove(); frame = null; ready = null;
    }
    function renderer() {
        if (ready) return ready;
        ready = new Promise((resolve, reject) => {
            frame = document.createElement('iframe');
            frame.className = 'pi-mermaid-worker';
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
            const listener = event => {
                if (event.source !== frame?.contentWindow || event.data?.type !== 'pi-mermaid-ready') return;
                clearTimeout(timer); window.removeEventListener('message', listener); resolve();
            };
            const timer = setTimeout(() => {
                window.removeEventListener('message', listener); resetFrame(); reject(new Error('load'));
            }, 15000);
            window.addEventListener('message', listener);
            frame.src = '/pi-mermaid-frame.html'; document.body.append(frame);
        });
        return ready;
    }
    window.addEventListener('message', event => {
        if (event.source !== frame?.contentWindow || event.data?.type !== 'pi-mermaid-result' || event.data.id !== pending?.id) return;
        const job = pending; pending = null; clearTimeout(job.timer);
        if (event.data.error || typeof event.data.svg !== 'string' || event.data.svg.length > 4000000) job.reject(new Error('render'));
        else job.resolve(event.data.svg);
    });
    async function render(source, theme) {
        const key = `${theme}:${source}`;
        if (cache.has(key)) return cache.get(key);
        await renderer();
        const svg = await new Promise((resolve, reject) => {
            const id = ++serial;
            const timer = setTimeout(() => { pending = null; resetFrame(); reject(new Error('timeout')); }, 10000);
            pending = { id, timer, resolve, reject };
            frame.contentWindow.postMessage({ type: 'pi-mermaid-render', id, source, dark: theme }, '*');
        });
        if (svg.length < 1000000) {
            while (cache.size && (cache.size >= 16 || cacheBytes + svg.length > 2000000)) {
                const first = cache.keys().next().value; cacheBytes -= cache.get(first).length; cache.delete(first);
            }
            cache.set(key, svg); cacheBytes += svg.length;
        }
        return svg;
    }
    function create(code) {
        const pre = code.parentElement;
        const figure = document.createElement('figure'); figure.className = 'pi-mermaid';
        const status = document.createElement('div'); status.className = 'pi-mermaid-status'; status.textContent = translateUi("正在绘制图表…");
        const details = document.createElement('details'); details.className = 'pi-mermaid-source';
        const summary = document.createElement('summary'); summary.textContent = translateUi("Mermaid 源码");
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'pi-mermaid-copy'; copy.textContent = translateUi("复制源码");
        copy.addEventListener('click', async () => {
            const text = code.textContent;
            try {
                if (navigator.clipboard?.writeText && window.isSecureContext) await navigator.clipboard.writeText(text);
                else {
                    const input = document.createElement('textarea'); input.value = text; input.className = 'pi-mermaid-clipboard';
                    document.body.append(input); input.select();
                    const ok = document.execCommand('copy'); input.remove(); copy.focus();
                    if (!ok) throw new Error('copy');
                }
                copy.textContent = translateUi("已复制");
            } catch { copy.textContent = translateUi("请展开源码手动复制"); }
        });
        pre.before(figure); details.append(summary, copy, pre); figure.append(status, details);
        const record = { code, figure, status, details, theme: null, image: null };
        records.set(code, record); return record;
    }
    async function drain() {
        if (running) return;
        running = true;
        try {
            while (queue.size) {
                const code = queue.values().next().value; queue.delete(code);
                if (!code.isConnected) continue;
                const item = records.get(code) || create(code), theme = dark();
                if (item.theme === theme) continue;
                item.theme = theme;
                const source = code.textContent;
                try {
                    if (source.length > 20000) throw new Error('size');
                    const svg = await render(source, theme);
                    if (!code.isConnected) continue;
                    // SVG is displayed as an image: no active links, scripts or page CSS.
                    const clean = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
                        FORBID_TAGS: ['foreignObject', 'a', 'image', 'script', 'animate', 'set'], FORBID_ATTR: ['href', 'xlink:href'] });
                    const url = URL.createObjectURL(new Blob([clean], { type: 'image/svg+xml' }));
                    const image = new Image(); image.alt = translateUi("Mermaid 图表（文字说明见下方源码）"); image.className = 'pi-mermaid-image';
                    const svgRoot = new DOMParser().parseFromString(clean, 'image/svg+xml').documentElement;
                    const viewBox = svgRoot.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
                    if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[2] <= 10000) image.style.width = `${viewBox[2]}px`;
                    image.src = url;
                    try { await image.decode(); } finally { URL.revokeObjectURL(url); }
                    if (!code.isConnected) continue;
                    item.image?.remove(); item.image = image; item.status.before(image); item.status.hidden = true;
                    item.figure.dataset.state = 'ready'; item.figure.dataset.theme = theme ? 'dark' : 'light';
                } catch {
                    if (!code.isConnected) continue;
                    item.status.hidden = false; item.status.textContent = translateUi("图表未能显示，可查看或复制源码。");
                    item.details.open = true; item.figure.dataset.state = 'error';
                }
                if (code.isConnected && dark() !== theme) queue.add(code);
            }
        } finally { running = false; }
    }
    function scan() {
        scanning = false;
        document.querySelectorAll(selector).forEach(code => {
            const record = records.get(code);
            if (!record || record.theme !== dark()) queue.add(code);
        });
        void drain();
    }
    function schedule() {
        if (scanning) return;
        scanning = true; requestAnimationFrame(scan);
    }
    new MutationObserver(changes => {
        if (changes.some(change => [...change.addedNodes].some(node => node.nodeType === 1 &&
            !node.closest?.('.pi-mermaid') && (node.matches?.('.pi-markdown, pre, code') || node.querySelector?.(selector))))) schedule();
    }).observe(document.body, { childList: true, subtree: true });
    new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    schedule();
})();
