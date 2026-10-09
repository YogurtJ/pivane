/* Presentation helpers shared by the artifacts center: menus, toasts and formatting.
   No network, storage or authority decisions live here. */
(() => {
    const tr = (zh, en) => window.PiI18n?.locale?.startsWith('en') ? en : zh;
    const locale = () => window.PiI18n?.locale || 'zh-CN';
    function node(tag, text, cls) {
        const n = document.createElement(tag);
        if (text != null) n.textContent = text;
        if (cls) n.className = cls;
        return n;
    }
    function icon(name, style = 'fa-solid') { const i = node('i', null, `${style} ${name}`); i.setAttribute('aria-hidden', 'true'); return i; }
    // label is always the accessible name. iconOnly keeps it for assistive tech and tooltips.
    function button(label, fn, cls = '', options = {}) {
        const b = node('button', null, cls); b.type = 'button';
        if (options.icon) b.append(icon(options.icon, options.iconStyle));
        if (label != null) {
            const text = node('span', label, options.iconOnly ? 'artifacts-sr' : 'artifacts-label');
            b.append(text);
            if (options.iconOnly) { b.setAttribute('aria-label', label); b.title = label; }
        }
        if (fn) b.addEventListener('click', fn);
        return b;
    }
    function relabel(b, label, iconName) {
        const text = b.querySelector(':scope > .artifacts-label, :scope > .artifacts-sr'); if (text) text.textContent = label;
        if (b.hasAttribute('aria-label')) { b.setAttribute('aria-label', label); b.title = label; }
        if (iconName) { const i = b.querySelector(':scope > i'); if (i) i.className = i.className.replace(/\bfa-(?!solid|regular)[\w-]+/g, '').trim() + ' ' + iconName; }
    }
    const KINDS = {
        document: ['fa-file-lines', '文档', 'Documents'], image: ['fa-image', '图像', 'Images'], video: ['fa-film', '视频', 'Videos'],
        audio: ['fa-wave-square', '音频', 'Audio'], web: ['fa-window-maximize', '网页', 'Web pages'], other: ['fa-file-zipper', '其他', 'Other']
    };
    const kindIcon = kind => (KINDS[kind] || KINDS.other)[0];
    const kindLabel = kind => { const k = KINDS[kind] || KINDS.other; return tr(k[1], k[2]); };
    function extension(name) { const match = /\.([A-Za-z0-9]{1,6})$/.exec(String(name || '')); return match ? match[1].toUpperCase() : ''; }
    function bytes(value) {
        let n = Number(value); if (!Number.isFinite(n) || n < 0) return '';
        const units = ['B', 'KB', 'MB', 'GB']; let i = 0;
        while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
        return `${i === 0 ? n : n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
    }
    function day(iso) {
        const value = iso ? new Date(iso) : null; if (!value || Number.isNaN(value.getTime())) return '';
        const now = new Date(), start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diff = Math.round((start(now) - start(value)) / 86400000);
        if (diff === 0) return tr('今天', 'Today');
        if (diff === 1) return tr('昨天', 'Yesterday');
        return value.toLocaleDateString(locale(), value.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
    }
    function stamp(iso) {
        const value = iso ? new Date(iso) : null; if (!value || Number.isNaN(value.getTime())) return '';
        return value.toLocaleString(locale(), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    // Modal layers opened by the artifacts center. Toasts follow the top layer so
    // they stay visible (and clickable) above an open drawer or confirmation.
    const layers = [];
    function layer(dialog) {
        layers.push(dialog);
        dialog.addEventListener('close', () => { const i = layers.lastIndexOf(dialog); if (i >= 0) layers.splice(i, 1); placeToasts(); closeMenus(); }, { once: true });
        placeToasts();
    }

    let activeMenu = null;
    function closeMenus(focusTrigger = false) {
        if (!activeMenu) return false;
        const { panel, trigger } = activeMenu; activeMenu = null;
        panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
        if (focusTrigger && trigger.isConnected) trigger.focus();
        return true;
    }
    document.addEventListener('pointerdown', e => { if (activeMenu && !activeMenu.anchor.contains(e.target)) closeMenus(); }, true);
    // items(): [{ label, icon, run, danger, hidden, disabled, separator }]
    function menu(trigger, items, options = {}) {
        const anchor = node('span', null, 'artifacts-menu-anchor'), panel = node('div', null, 'artifacts-menu' + (options.up ? ' is-up' : '') + (options.start ? ' is-start' : ''));
        panel.setAttribute('role', 'menu'); panel.hidden = true; panel.id = 'artifacts-menu-' + Math.random().toString(36).slice(2, 9);
        trigger.setAttribute('aria-haspopup', 'menu'); trigger.setAttribute('aria-expanded', 'false'); trigger.setAttribute('aria-controls', panel.id);
        anchor.append(trigger, panel);
        const open = () => {
            closeMenus(); panel.replaceChildren();
            for (const item of items().filter(i => i && !i.hidden)) {
                if (item.separator) { if (panel.lastChild && !panel.lastChild.classList.contains('artifacts-menu-separator')) panel.append(node('div', null, 'artifacts-menu-separator')); continue; }
                // Return focus to the trigger first, so a dialog opened by the item restores focus there.
                const entry = button(item.label, () => { closeMenus(true); item.run(); }, 'artifacts-menu-item' + (item.danger ? ' is-danger' : ''), { icon: item.icon });
                entry.setAttribute('role', 'menuitem'); entry.disabled = Boolean(item.disabled); if (item.action) entry.dataset.action = item.action; panel.append(entry);
            }
            if (panel.lastChild?.classList.contains('artifacts-menu-separator')) panel.lastChild.remove();
            if (!panel.children.length) return;
            panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); activeMenu = { panel, trigger, anchor };
            panel.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
        };
        trigger.addEventListener('click', e => { e.stopPropagation(); if (activeMenu?.panel === panel) closeMenus(); else open(); });
        panel.addEventListener('keydown', e => {
            const entries = [...panel.querySelectorAll('button:not(:disabled)')], index = entries.indexOf(document.activeElement);
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenus(true); }
            else if (e.key === 'Tab') closeMenus();
            else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && entries.length) {
                e.preventDefault();
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? entries.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + entries.length) % entries.length;
                entries[next].focus();
            }
        });
        anchor.hasItems = () => items().some(i => i && !i.hidden && !i.separator);
        return anchor;
    }

    const region = node('section', null, 'artifacts-toasts');
    region.setAttribute('aria-label', tr('成果中心通知', 'Artifact notifications'));
    const live = node('div', null, 'artifacts-sr'); live.setAttribute('aria-live', 'polite'); live.setAttribute('role', 'status');
    function placeToasts() {
        const host = layers.filter(d => d.open).at(-1) || document.body;
        if (region.parentElement !== host) host.append(region);
        if (live.parentElement !== host) host.append(live);
        region.classList.toggle('in-layer', host !== document.body);
    }
    function toast(options) {
        placeToasts();
        const item = node('div', null, 'artifacts-toast'), body = node('div', null, 'artifacts-toast-body'), message = node('p');
        const glyph = node('span', null, 'artifacts-toast-icon');
        const actions = node('div', null, 'artifacts-toast-actions');
        const dismiss = button(tr('关闭通知', 'Dismiss'), () => close(), 'artifacts-toast-close', { icon: 'fa-xmark', iconOnly: true });
        item.append(glyph, body, actions, dismiss); body.append(message);
        let timer = null, closed = false;
        const close = () => {
            if (closed) return; closed = true; clearTimeout(timer);
            item.classList.remove('is-visible'); item.classList.add('is-leaving');
            setTimeout(() => item.remove(), 200);
        };
        const schedule = ms => { clearTimeout(timer); if (ms > 0) timer = setTimeout(close, ms); };
        const update = next => {
            const tone = next.tone || 'info';
            item.dataset.tone = tone; message.textContent = next.message || '';
            glyph.replaceChildren(tone === 'pending' ? node('span', null, 'artifacts-spinner') : icon(tone === 'success' ? 'fa-circle-check' : tone === 'error' ? 'fa-circle-exclamation' : 'fa-circle-info'));
            body.querySelector('ul')?.remove();
            if (next.details?.length) {
                const list = node('ul');
                for (const line of next.details.slice(0, 6)) list.append(node('li', line));
                if (next.details.length > 6) list.append(node('li', tr(`…另 ${next.details.length - 6} 项`, `…and ${next.details.length - 6} more`)));
                body.append(list);
            }
            actions.replaceChildren();
            if (next.action) actions.append(button(next.action.label, () => { close(); next.action.run(); }, 'artifacts-toast-action'));
            item.setAttribute('role', tone === 'error' ? 'alert' : 'status');
            live.textContent = next.message || '';
            schedule(next.timeout ?? (tone === 'pending' ? 0 : tone === 'error' ? 12000 : next.action ? 7000 : 4200));
            if (!item.isConnected) { region.append(item); requestAnimationFrame(() => item.classList.add('is-visible')); }
            while (region.children.length > 3) region.firstElementChild.remove();
        };
        item.addEventListener('pointerenter', () => clearTimeout(timer));
        item.addEventListener('pointerleave', () => { if (!closed && item.dataset.tone !== 'pending') schedule(3000); });
        item.addEventListener('focusin', () => clearTimeout(timer));
        update(options);
        return { update, close };
    }
    document.addEventListener('DOMContentLoaded', placeToasts);
    window.PiArtifactsUI = Object.freeze({ tr, node, icon, button, relabel, menu, closeMenus, layer, toast, kindIcon, kindLabel, extension, bytes, day, stamp, kinds: Object.keys(KINDS) });
})();
