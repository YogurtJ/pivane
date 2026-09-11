/* Browser-only display language. No conversation, model or server preferences are changed. */
(() => {
    'use strict';
    const KEY = 'pi.workspace.language';
    const choices = new Set(['system', 'zh-CN', 'en']);
    const rows = globalThis.PiI18nCatalog || [];
    const messages = new Map(rows.map(([source, english]) => [source, english]));
    function resolve(preference, languages = []) {
        if (preference === 'zh-CN' || preference === 'en') return preference;
        for (const language of languages) {
            if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
            if (/^en(?:-|$)/i.test(language)) return 'en';
        }
        return 'en';
    }
    function preference() {
        try { const value = localStorage.getItem(KEY); return choices.has(value) ? value : 'system'; }
        catch { return 'system'; }
    }
    const browserLanguages = () => globalThis.navigator?.languages?.length ? navigator.languages : [globalThis.navigator?.language || 'en'];
    // Freeze the display language for this page's lifetime. Reopening applies the saved preference
    // without rebuilding active dialogs, losing drafts, or disconnecting temporary sessions.
    const locale = resolve(preference(), browserLanguages());
    function t(source, ...values) {
        if (source === null || source === undefined) return '';
        const template = locale === 'en' ? messages.get(source) ?? source : source;
        return String(template).replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
    }
    function save(value) {
        if (!choices.has(value)) throw new Error('Unsupported interface language');
        try { localStorage.setItem(KEY, value); return true; }
        catch { return false; }
    }
    function translateStatic(root = document) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
        const markers = [];
        while (walker.nextNode()) markers.push(walker.currentNode);
        for (const marker of markers) {
            const match = /^i18n:s(\d+)$/.exec(marker.data);
            const text = marker.nextSibling;
            if (!match || text?.nodeType !== Node.TEXT_NODE) continue;
            const row = rows[Number(match[1])];
            if (!row) continue;
            text.data = text.data.replace(/\S[\s\S]*\S|\S/, () => t(row[0]));
            // The locale is fixed for this page. Consume the marker so existing DOM/range
            // readers still see the text as the first child of its original element.
            marker.remove();
        }
        for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
            for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
                const key = node.getAttribute(`data-i18n-${attribute}`);
                const row = /^s\d+$/.test(key) ? rows[Number(key.slice(1))] : null;
                if (row) node.setAttribute(attribute, t(row[0]));
            }
        }
    }
    globalThis.PiI18n = Object.freeze({ t, locale, resolve, preference, save, translateStatic });
    if (typeof document === 'undefined') return;
    document.documentElement.lang = locale;
    document.addEventListener('DOMContentLoaded', () => {
        translateStatic();
        const select = document.getElementById('workspace-language');
        const status = document.getElementById('workspace-language-status');
        if (!select) return;
        const languageHint = document.getElementById('workspace-language-hint');
        if (languageHint) languageHint.hidden = locale === 'en';
        const render = () => {
            select.value = preference();
            const pending = resolve(preference(), browserLanguages()) !== locale;
            status.textContent = pending
                ? t('语言已保存，下次打开或刷新页面时生效。刷新前请保留草稿和附件；临时会话与侧聊会结束。')
                : t('跟随浏览器语言，也可为当前浏览器单独选择。界面语言不改变模型回复或朗读语言。');
        };
        select.setAttribute('aria-label', t('界面语言'));
        select.options[0].textContent = t('跟随浏览器');
        render();
        select.addEventListener('change', () => {
            if (save(select.value)) render();
            else { select.value = preference(); status.textContent = t('浏览器无法保存语言设置，请检查网站存储权限。'); }
        });
        window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) render(); });
        window.addEventListener('languagechange', render);
    });
})();
