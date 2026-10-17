/* Shared building blocks for the assistant identity pages (shell, overview, persona, memory,
   skills, learning). Safe DOM only: text goes through textContent, Markdown through marked +
   DOMPurify. Pages compose these helpers; they own no profile data or request state. */
(() => {
    'use strict';
    const t = (text, ...args) => globalThis.PiI18n?.t(text, ...args)
        || String(text).replace(/\{(\d+)\}/g, (_, index) => args[index] ?? `{${index}}`);
    const locale = () => globalThis.PiI18n?.locale === 'en' ? 'en' : 'zh-CN';
    const PROPERTIES = new Set(['value', 'checked', 'selected', 'disabled', 'hidden', 'required', 'open', 'readOnly', 'maxLength', 'min', 'max', 'step', 'rows']);
    let sequence = 0;
    const uid = prefix => `${prefix}-${++sequence}`;

    function append(node, children) {
        for (const child of [children].flat(Infinity)) {
            if (child === undefined || child === null || child === false || child === '') continue;
            node.append(child instanceof Node ? child : document.createTextNode(String(child)));
        }
        return node;
    }
    // el('div', { class: 'x', text: 'hi', 'aria-label': 'y', on: { click } }, [children])
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props || {})) {
            if (value === undefined || value === null || value === false && !PROPERTIES.has(key)) continue;
            if (key === 'class' || key === 'className') node.className = value;
            else if (key === 'text') node.textContent = String(value);
            else if (key === 'dataset') Object.assign(node.dataset, value);
            else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
            else if (key === 'on') for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
            else if (PROPERTIES.has(key)) node[key] = value;
            else node.setAttribute(key, value === true ? '' : String(value));
        }
        return append(node, children);
    }
    const icon = (name, style = 'solid') => el('i', { class: `fa-${style} fa-${name}`, 'aria-hidden': 'true' });

    // variant: primary | secondary | ghost | danger | quiet; size: sm | md; iconOnly needs label for aria.
    function button({ label = '', icon: iconName, variant = 'secondary', size = 'md', title, onClick, type = 'button', disabled = false,
        className = '', iconOnly = false, badge, attrs = {} } = {}) {
        const classes = ['pi-id-btn', `pi-id-btn-${variant}`, size === 'sm' && 'pi-id-btn-sm', iconOnly && 'pi-id-btn-icon', className].filter(Boolean).join(' ');
        // Collapsible buttons lose their visible text on phones, so they always carry the name too.
        const named = iconOnly || String(className).split(/\s+/).includes('pi-id-btn-collapsible');
        const node = el('button', { type, class: classes, disabled, title: title || (named ? label : undefined),
            'aria-label': named ? label : undefined, ...attrs, on: onClick ? { click: onClick } : undefined },
        [iconName && icon(iconName), !iconOnly && label && el('span', { text: label }),
            badge !== undefined && badge !== null && badge !== '' && el('span', { class: 'pi-id-badge', text: String(badge) })]);
        return node;
    }
    function setBusy(node, busy, busyLabel) {
        if (!node) return;
        node.disabled = Boolean(busy);
        node.classList.toggle('is-busy', Boolean(busy));
        node.setAttribute('aria-busy', String(Boolean(busy)));
        const label = node.querySelector(':scope > span:not(.pi-id-badge)');
        if (label && busyLabel !== undefined) {
            label.dataset.idle ??= label.textContent;
            label.textContent = busy ? busyLabel : label.dataset.idle;
        }
    }

    // tone: neutral | accent | green | blue | amber | danger | violet
    const chip = (text, tone = 'neutral', { icon: iconName, title, className = '' } = {}) =>
        el('span', { class: `pi-id-chip ${className}`.trim(), dataset: { tone }, title }, [iconName && icon(iconName), el('span', { text })]);
    const CATEGORY = Object.freeze({ fact: ['事实', 'blue', 'circle-info'], preference: ['偏好', 'green', 'heart'],
        correction: ['纠错', 'amber', 'pen-to-square'], failure: ['失败经验', 'danger', 'triangle-exclamation'], procedure: ['流程', 'violet', 'list-check'] });
    const categoryLabel = key => t(CATEGORY[key]?.[0] || key || '事实');
    const categoryChip = key => chip(categoryLabel(key), CATEGORY[key]?.[1] || 'neutral', { className: 'pi-id-category' });
    const dot = (tone = 'neutral', label) => el('span', { class: 'pi-id-dot', dataset: { tone }, role: label ? 'img' : undefined,
        'aria-label': label, 'aria-hidden': label ? undefined : 'true', title: label });

    // A labelled progress meter. level: ok (<near), near (>= near), full (>= 1 or forced).
    function meter({ value = 0, max = 0, label = '', valueText, detail, near = 0.8, level: forced, compact = false } = {}) {
        const ratio = max > 0 ? value / max : 0;
        const level = forced || (ratio >= 1 ? 'full' : ratio >= near ? 'near' : 'ok');
        const fill = el('span', { class: 'pi-id-meter-fill' }); fill.style.width = `${Math.max(value > 0 ? 2 : 0, Math.min(100, Math.round(ratio * 100)))}%`;
        return el('div', { class: `pi-id-meter${compact ? ' is-compact' : ''}`, dataset: { level } }, [
            el('div', { class: 'pi-id-meter-head' }, [el('span', { class: 'pi-id-meter-label', text: label }),
                el('span', { class: 'pi-id-meter-value', text: valueText ?? `${number(value)} / ${number(max)}` })]),
            el('span', { class: 'pi-id-meter-track', role: 'progressbar', 'aria-label': label, 'aria-valuemin': 0,
                'aria-valuemax': Math.max(0, max), 'aria-valuenow': Math.max(0, Math.min(value, max || value)) }, [fill]),
            detail && el('small', { class: 'pi-id-meter-detail', text: detail })]);
    }

    // An (i) toggle with an inline explanation panel; works with touch and keyboards (no hover tooltip).
    function info({ label, body }) {
        const id = uid('pi-id-info');
        const panel = el('div', { id, class: 'pi-id-info-panel', hidden: true, role: 'note' }, [typeof body === 'string' ? el('p', { text: body }) : body]);
        const toggle = el('button', { type: 'button', class: 'pi-id-info', 'aria-expanded': 'false', 'aria-controls': id,
            'aria-label': t('了解“{0}”', label), title: t('了解“{0}”', label) }, [icon('circle-info')]);
        toggle.addEventListener('click', () => {
            const open = toggle.getAttribute('aria-expanded') !== 'true';
            toggle.setAttribute('aria-expanded', String(open)); panel.hidden = !open;
        });
        return { button: toggle, panel };
    }

    // Segmented control: items [{ id, label, icon, count, disabled, title }].
    function segmented({ items, value, onChange, label, className = '' }) {
        const group = el('div', { class: `pi-id-seg ${className}`.trim(), role: 'group', 'aria-label': label });
        for (const item of items) {
            const current = item.id === value;
            group.append(el('button', { type: 'button', class: 'pi-id-seg-item', 'aria-pressed': String(current), disabled: item.disabled, title: item.title,
                dataset: { value: item.id }, on: { click: () => { if (item.id !== value) onChange?.(item.id); } } }, [
                item.icon && icon(item.icon), el('span', { text: item.label }), item.hint && el('span', { class: 'pi-id-seg-hint', text: item.hint }),
                item.count !== undefined && item.count !== null && el('span', { class: 'pi-id-seg-count', text: String(item.count) })]));
        }
        return group;
    }

    // Toggle switch row: { label, description, checked, disabled, info, onChange, name }
    function switchRow({ label, description, checked = false, disabled = false, info: infoBody, onChange, name, id = uid('pi-id-switch') }) {
        const input = el('input', { id, type: 'checkbox', role: 'switch', class: 'pi-id-switch', name, checked, disabled,
            on: onChange ? { change: event => onChange(event.target.checked, event) } : undefined });
        const help = infoBody ? info({ label, body: infoBody }) : null;
        const row = el('div', { class: 'pi-id-switch-row' }, [
            el('div', { class: 'pi-id-switch-copy' }, [
                el('div', { class: 'pi-id-switch-title' }, [el('label', { for: id, text: label }), help?.button]),
                description && el('p', { class: 'pi-id-switch-desc', text: description })]),
            input]);
        if (help) row.append(help.panel);
        return { row, input };
    }

    function empty({ icon: iconName = 'inbox', title, text, actions = [], compact = false }) {
        return el('div', { class: `pi-id-empty${compact ? ' is-compact' : ''}` }, [
            el('span', { class: 'pi-id-empty-icon' }, [icon(iconName)]), title && el('h4', { text: title }),
            text && el('p', { text }), actions.length ? el('div', { class: 'pi-id-empty-actions' }, actions) : null]);
    }

    function card({ title, icon: iconName, subtitle, actions = [], className = '', tag = 'section', headingLevel = 3 } = {}, children = []) {
        const head = title || actions.length ? el('header', { class: 'pi-id-card-head' }, [
            el('div', { class: 'pi-id-card-title' }, [iconName && el('span', { class: 'pi-id-card-icon' }, [icon(iconName)]),
                el('div', {}, [title && el(`h${headingLevel}`, { text: title }), subtitle && el('p', { text: subtitle })])]),
            actions.length ? el('div', { class: 'pi-id-card-actions' }, actions) : null]) : null;
        return el(tag, { class: `pi-id-card ${className}`.trim() }, [head, el('div', { class: 'pi-id-card-body' }, children)]);
    }

    // Overview statistic tile; clickable when onClick is given.
    function stat({ icon: iconName, label, value, detail, tone = 'accent', onClick, badge, title }) {
        const tag = onClick ? 'button' : 'div';
        return el(tag, { class: 'pi-id-stat', type: onClick ? 'button' : undefined, dataset: { tone }, title, on: onClick ? { click: onClick } : undefined }, [
            el('span', { class: 'pi-id-stat-icon' }, [icon(iconName)]),
            el('span', { class: 'pi-id-stat-label', text: label }),
            el('span', { class: 'pi-id-stat-value', text: value ?? '—' }),
            detail && el('span', { class: 'pi-id-stat-detail' }, [detail]),
            badge && el('span', { class: 'pi-id-stat-badge', text: badge })]);
    }

    // Dropdown menu: items [{ label, icon, tone, description, onSelect, disabled }]; returns the wrapper.
    function menu({ label, icon: iconName = 'ellipsis', iconOnly = true, variant = 'ghost', items, align = 'end', className = '' }) {
        const id = uid('pi-id-menu');
        const trigger = button({ label, icon: iconName, iconOnly, variant, attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': id } });
        const list = el('div', { id, class: 'pi-id-menu-list', role: 'menu', hidden: true, dataset: { align } });
        const wrap = el('div', { class: `pi-id-menu ${className}`.trim() }, [trigger, list]);
        const close = (focus = false) => {
            if (list.hidden) return;
            list.hidden = true; trigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('pointerdown', outside, true);
            if (focus) trigger.focus({ preventScroll: true });
        };
        const outside = event => { if (!wrap.contains(event.target)) close(); };
        for (const item of items) {
            const row = el('button', { type: 'button', role: 'menuitem', class: 'pi-id-menu-item', disabled: item.disabled, dataset: { tone: item.tone || 'neutral' },
                on: { click: () => { close(true); item.onSelect?.(); } } }, [item.icon && icon(item.icon),
                el('span', { class: 'pi-id-menu-copy' }, [el('span', { text: item.label }), item.description && el('small', { text: item.description })])]);
            list.append(row);
        }
        trigger.addEventListener('click', () => {
            if (!list.hidden) { close(); return; }
            list.hidden = false; trigger.setAttribute('aria-expanded', 'true');
            document.addEventListener('pointerdown', outside, true);
            list.querySelector('[role=menuitem]:not(:disabled)')?.focus({ preventScroll: true });
        });
        list.addEventListener('keydown', event => {
            const rows = [...list.querySelectorAll('[role=menuitem]:not(:disabled)')], index = rows.indexOf(document.activeElement);
            if (event.key === 'Escape') { event.preventDefault(); close(true); }
            else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault(); rows[(index + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
            } else if (event.key === 'Tab') close();
        });
        return wrap;
    }

    // Toasts live in one polite region per host. Success/info fade out; warnings/errors stay until closed.
    function createToaster(host) {
        const region = el('div', { class: 'pi-id-toasts', role: 'status', 'aria-live': 'polite' });
        host.append(region);
        const timers = new WeakMap();
        function dismiss(node) { clearTimeout(timers.get(node)); node.remove(); }
        function show(text, { tone = 'success', persistent, action } = {}) {
            if (!text) return null;
            for (const node of region.querySelectorAll('.pi-id-toast')) if (node.dataset.text === text) dismiss(node);
            const stay = persistent ?? (tone === 'warning' || tone === 'error');
            const node = el('div', { class: 'pi-id-toast', dataset: { tone, text } }, [
                icon(tone === 'success' ? 'circle-check' : tone === 'info' ? 'circle-info' : 'circle-exclamation'),
                el('span', { class: 'pi-id-toast-text', text }),
                action && button({ label: action.label, variant: 'quiet', size: 'sm', onClick: () => { dismiss(node); action.onClick(); } }),
                button({ label: t('关闭提示'), icon: 'xmark', iconOnly: true, variant: 'ghost', size: 'sm', onClick: () => dismiss(node) })]);
            region.append(node);
            while (region.children.length > 3) dismiss(region.firstElementChild);
            if (!stay) timers.set(node, setTimeout(() => dismiss(node), 4200));
            return node;
        }
        return { show, clear: () => { for (const node of [...region.children]) dismiss(node); }, element: region };
    }

    // Sticky save bar shared by persona, full-text documents and learning settings.
    function createSaveBar({ onSave, onDiscard, saveLabel = t('保存'), discardLabel = t('放弃修改'), hint = '' } = {}) {
        const message = el('strong', { class: 'pi-id-savebar-title' });
        const note = el('small', { class: 'pi-id-savebar-hint', text: hint });
        const discard = button({ label: discardLabel, variant: 'ghost', onClick: () => onDiscard?.() });
        const save = button({ label: saveLabel, icon: 'floppy-disk', variant: 'primary', onClick: () => onSave?.() });
        const element = el('div', { class: 'pi-id-savebar', dataset: { visible: 'false', tone: 'dirty' }, role: 'region', 'aria-label': t('保存修改') }, [
            el('span', { class: 'pi-id-savebar-dot', 'aria-hidden': 'true' }), el('div', { class: 'pi-id-savebar-copy' }, [message, note]),
            el('div', { class: 'pi-id-savebar-actions' }, [onDiscard ? discard : null, save])]);
        if (!onDiscard) discard.hidden = true;
        function set({ dirty = false, saving = false, canSave = true, text, tone, hint: nextHint, visible } = {}) {
            const shown = visible ?? (dirty || saving || Boolean(text && tone && tone !== 'dirty'));
            element.dataset.visible = String(shown);
            element.dataset.tone = tone || (saving ? 'saving' : 'dirty');
            element.inert = !shown;
            message.textContent = text || (saving ? t('正在保存…') : t('有未保存的修改'));
            if (nextHint !== undefined) note.textContent = nextHint;
            note.hidden = !note.textContent;
            save.disabled = saving || !dirty || !canSave; discard.disabled = saving;
            setBusy(save, saving, saving ? t('正在保存…') : undefined);
            if (!saving) save.disabled = !dirty || !canSave;
        }
        set();
        return { element, set, saveButton: save, discardButton: discard };
    }

    function relativeTime(value) {
        const date = value instanceof Date ? value : new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        const seconds = Math.round((date.getTime() - Date.now()) / 1000), abs = Math.abs(seconds);
        if (abs < 45) return t('刚刚');
        const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
        if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute');
        if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour');
        if (abs < 7 * 86400) return format.format(Math.round(seconds / 86400), 'day');
        return date.toLocaleDateString(locale(), { year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' });
    }
    const time = value => {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? el('time', { datetime: date.toISOString(), title: date.toLocaleString(locale()), text: relativeTime(date) }) : null;
    };
    const number = value => Number.isFinite(value) ? new Intl.NumberFormat(locale()).format(value) : '—';
    const compact = value => Number.isFinite(value) ? new Intl.NumberFormat(locale(), { notation: 'compact', maximumFractionDigits: 1 }).format(value) : '—';

    // Renders untrusted Markdown into target through marked + DOMPurify; falls back to plain text.
    function markdown(target, text, { empty: emptyText = '' } = {}) {
        target.replaceChildren();
        target.classList.add('pi-id-markdown');
        if (!String(text || '').trim()) { if (emptyText) target.append(el('p', { class: 'pi-id-muted', text: emptyText })); return target; }
        if (window.marked && window.DOMPurify) {
            target.innerHTML = window.DOMPurify.sanitize(window.marked.parse(String(text)), {
                FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'script'], FORBID_ATTR: ['style'] });
            for (const link of target.querySelectorAll('a[href]')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        } else target.append(el('pre', { text: String(text) }));
        return target;
    }

    // UTF-8 byte length (SOUL is limited in bytes, documents in characters).
    const bytes = text => new TextEncoder().encode(String(text ?? '')).length;

    globalThis.PiIdentityUI = Object.freeze({ t, locale, el, append, icon, button, setBusy, chip, categoryChip, categoryLabel, CATEGORY, dot,
        meter, info, segmented, switchRow, empty, card, stat, menu, createToaster, createSaveBar, relativeTime, time, number, compact, markdown, bytes, uid });
})();
