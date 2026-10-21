// Chat receipts for successful deliver_files results, plus file-type icons for
// delivery and project file links inside replies. Display only: the native tool
// result remains the record.
(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const node = (tag, className, text) => {
        const element = document.createElement(tag); if (className) element.className = className;
        if (text !== undefined) element.textContent = text; return element;
    };
    const glyph = (name, style = 'regular') => { const element = node('i', `fa-${style} fa-${name}`); element.setAttribute('aria-hidden', 'true'); return element; };
    const VISIBLE_FILES = 5, THUMBNAIL_BYTES = 8 * 1024 * 1024;
    const KINDS = [
        ['image', 'image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico']],
        ['pdf', 'file-pdf', ['pdf']],
        ['video', 'file-video', ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi']],
        ['audio', 'file-audio', ['mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus']],
        ['archive', 'file-zipper', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']],
        ['sheet', 'file-excel', ['xlsx', 'xls', 'csv', 'tsv', 'ods']],
        ['doc', 'file-word', ['docx', 'doc', 'odt', 'rtf']],
        ['slides', 'file-powerpoint', ['pptx', 'ppt', 'odp', 'key']],
        ['text', 'file-lines', ['md', 'markdown', 'txt', 'log', 'rst']],
        ['code', 'file-code', ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'json', 'html', 'htm', 'css', 'xml', 'yaml', 'yml', 'toml', 'sh', 'sql', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'rb', 'php', 'ini']]
    ];
    const extensionOf = name => { const match = /\.([a-z0-9]{1,10})$/i.exec(String(name || '').trim()); return match ? match[1].toLowerCase() : ''; };
    function kindOf(name) {
        const extension = extensionOf(name);
        const found = KINDS.find(([, , extensions]) => extensions.includes(extension));
        return { key: found?.[0] || 'file', icon: found?.[1] || 'file', extension };
    }
    function sizeText(size) {
        // Decimal units, as file managers show them.
        return size >= 1e9 ? `${(size / 1e9).toLocaleString(undefined, { maximumFractionDigits: 2 })} GB`
            : size >= 1e6 ? `${(size / 1e6).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`
                : size >= 1e3 ? `${Math.round(size / 1e3).toLocaleString()} KB` : `${size} B`;
    }
    function receiptOf(message) {
        const receipt = message?.details?.pivaneDeliverable;
        if (message?.isError || message?.toolName !== 'deliver_files' || !receipt
            || !/^[a-f0-9]{64}$/.test(receipt.reference?.id || '') || !/^[a-f0-9]{64}$/.test(receipt.reference?.manifestRevision || '')
            || typeof receipt.title !== 'string' || receipt.title.length > 160 || !Array.isArray(receipt.files) || !receipt.files.length || receipt.files.length > 20
            || receipt.files.some((file, index) => typeof file.name !== 'string' || file.name.length > 4096
                || !Number.isSafeInteger(file.size) || file.size < 0 || file.href !== `#pi-delivery=${receipt.reference.id}/${index}`)) return null;
        return receipt;
    }
    // Delivery id -> file names, so model-written #pi-delivery links get the right icon.
    const names = new Map();
    function decorateLinks(root) {
        root?.querySelectorAll?.('a[href^="#pi-delivery="], a[href^="#pi-file="]').forEach(link => {
            if (link.querySelector(':scope > .pi-file-link-icon')) return;
            const href = link.getAttribute('href'), delivery = /^#pi-delivery=([a-f0-9]{64})\/(\d{1,2})$/.exec(href);
            let name = '';
            if (delivery) name = names.get(delivery[1])?.[Number(delivery[2])] || '';
            else { try { name = decodeURIComponent(href.slice(9)).replace(/:\d+$/, ''); } catch {} }
            if (!extensionOf(name)) name = link.textContent;
            const kind = kindOf(name), icon = glyph(kind.icon); icon.classList.add('pi-file-link-icon');
            link.classList.add('pi-file-link'); link.dataset.fileKind = kind.key; link.prepend(icon);
        });
    }
    function create(host) {
        const cards = new Map(), urls = new Map();
        const key = () => host.context().key;
        let observer = null;
        const release = card => { for (const url of urls.get(card) || []) URL.revokeObjectURL(url); urls.delete(card); };
        async function loadThumbnail(tile, target, card, contextKey) {
            const context = host.context();
            if (!host.api || context.key !== contextKey || !context.sessionId) return;
            try {
                const query = new URLSearchParams({ cwd: context.cwd, sessionId: context.sessionId, id: target.deliveryId, index: target.index });
                const data = await host.api(`/api/pi/deliverables?${query}`);
                if (key() !== contextKey || !card.isConnected || data?.encoding !== 'base64' || typeof data.base64 !== 'string' || !/^image\//.test(data.mime || '')) return;
                const bytes = Uint8Array.from(atob(data.base64), char => char.charCodeAt(0));
                const url = URL.createObjectURL(new Blob([bytes], { type: data.mime.split(';')[0] }));
                if (!urls.has(card)) urls.set(card, []); urls.get(card).push(url);
                const image = node('img'); image.alt = ''; image.decoding = 'async'; image.src = url;
                image.addEventListener('load', () => tile.classList.add('has-thumbnail'), { once: true });
                tile.replaceChildren(image);
            } catch {}
        }
        function observe(tile, start) {
            if (!('IntersectionObserver' in window)) { start(); return; }
            observer ||= new IntersectionObserver(entries => {
                for (const entry of entries) if (entry.isIntersecting) { observer.unobserve(entry.target); entry.target._piThumbnail?.(); delete entry.target._piThumbnail; }
            }, { rootMargin: '200px' });
            tile._piThumbnail = start; observer.observe(tile);
        }
        return {
            decorateLinks,
            reset() { for (const card of cards.values()) release(card); cards.clear(); observer?.disconnect(); observer = null; },
            prune() { for (const [id, card] of cards) if (!card.isConnected) { release(card); cards.delete(id); } },
            render(message) {
                const receipt = receiptOf(message), id = message?.toolCallId;
                if (!id) return null;
                if (!receipt) { if (message?.isError) { const old = cards.get(id); if (old) { release(old); old.remove(); } cards.delete(id); } return null; }
                names.set(receipt.reference.id, receipt.files.map(file => file.name));
                if (cards.get(id)?.isConnected) return null;
                const contextKey = key(), card = node('section', 'pi-delivery-receipt');
                card.dataset.readingKey = `delivery:${id}`; card.setAttribute('aria-label', translateUi('交付文件'));
                const head = node('div', 'pi-delivery-receipt-head');
                head.append(glyph('folder-open'), node('strong', 'pi-delivery-receipt-title', receipt.title || translateUi('交付文件')),
                    node('span', 'pi-delivery-receipt-count', translateUi('{0} 个文件', receipt.files.length)));
                const list = node('ul', 'pi-delivery-receipt-list');
                receipt.files.forEach((file, index) => {
                    const kind = kindOf(file.name), target = { deliveryId: receipt.reference.id, index, path: file.name, name: file.name };
                    const row = node('li', 'pi-delivery-receipt-file'); row.dataset.fileKind = kind.key;
                    if (index >= VISIBLE_FILES) row.hidden = true;
                    const open = node('button', 'pi-delivery-receipt-open'); open.type = 'button';
                    open.title = translateUi('打开预览'); open.setAttribute('aria-label', translateUi('预览 {0}', file.name));
                    const tile = node('span', 'pi-delivery-receipt-icon'); tile.append(glyph(kind.icon));
                    const caption = node('span', 'pi-delivery-receipt-name');
                    caption.append(node('strong', '', file.name), node('small', '', [kind.extension.toUpperCase(), sizeText(file.size)].filter(Boolean).join(' · ')));
                    open.append(tile, caption);
                    open.addEventListener('click', () => { if (key() === contextKey) host.open(target); });
                    const download = node('button', 'pi-delivery-receipt-download'); download.type = 'button';
                    const label = host.downloads.enabled ? translateUi('下载') : translateUi('打开后下载');
                    download.title = label; download.setAttribute('aria-label', `${label} ${file.name}`); download.append(glyph('arrow-down', 'solid'));
                    download.addEventListener('click', async () => {
                        if (key() !== contextKey || download.disabled) return;
                        download.disabled = true; download.classList.add('is-busy');
                        try {
                            if (host.downloads.enabled) await host.downloads.download(target);
                            else host.open(target);
                        } catch (error) { if (error.name !== 'AbortError') host.notify(error.message, 'error'); }
                        finally { download.disabled = false; download.classList.remove('is-busy'); }
                    });
                    row.append(open, download); list.append(row);
                    if (kind.key === 'image' && file.size <= THUMBNAIL_BYTES && host.api) observe(tile, () => loadThumbnail(tile, target, card, contextKey));
                });
                card.append(head, list);
                if (receipt.files.length > VISIBLE_FILES) {
                    const more = node('button', 'pi-delivery-receipt-more', translateUi('显示其余 {0} 个文件', receipt.files.length - VISIBLE_FILES)); more.type = 'button';
                    more.addEventListener('click', () => {
                        const rows = [...list.children]; rows.forEach(row => { row.hidden = false; });
                        more.remove(); rows[VISIBLE_FILES]?.querySelector('button')?.focus({ preventScroll: true });
                    });
                    card.append(more);
                }
                cards.set(id, card); return card;
            }
        };
    }
    globalThis.PiDeliveryCards = { create, receiptOf, kindOf, decorateLinks };
})();
