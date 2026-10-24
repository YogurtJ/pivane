/* Browser-only display language. No conversation, model or server preferences are changed. */
(() => {
    'use strict';
    const KEY = 'pi.workspace.language';
    const choices = new Set(['system', 'zh-CN', 'en']);
    const rows = globalThis.PiI18nCatalog || [];
    // Optional third column is the English singular when the first value is exactly 1.
    const messages = new Map(rows.map(([source, english, singular]) => [source, { english, singular }]));
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
    // Modules translate at load: keep this locale fixed and deliberately reload to apply a change.
    const locale = resolve(preference(), browserLanguages());
    function t(source, ...values) {
        if (source === null || source === undefined) return '';
        const message = locale === 'en' ? messages.get(source) : null;
        const template = message ? (values[0] === 1 ? message.singular ?? message.english : message.english) : source;
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
            // The page text is the stable translation key. Legacy numeric
            // markers only locate text nodes; catalog insertion/reordering must
            // never replace a label with another row, including in Chinese.
            const marked = /^i18n(?::s\d+)?$/.test(marker.data);
            const text = marker.nextSibling;
            if (!marked || text?.nodeType !== Node.TEXT_NODE) continue;
            text.data = text.data.replace(/\S[\s\S]*\S|\S/, source => t(source));
            // The locale is fixed for this page. Consume the marker so existing DOM/range
            // readers still see the text as the first child of its original element.
            marker.remove();
        }
        for (const attribute of ['title', 'aria-label', 'placeholder', 'alt']) {
            for (const node of root.querySelectorAll(`[data-i18n-${attribute}]`)) {
                const source = node.getAttribute(attribute);
                if (source !== null) node.setAttribute(attribute, t(source));
                node.removeAttribute(`data-i18n-${attribute}`);
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
        const actions = document.createElement('div'); actions.className = 'workspace-language-actions'; actions.hidden = true;
        const switchButton = document.createElement('button'); switchButton.type = 'button'; switchButton.id = 'workspace-language-switch';
        switchButton.className = 'settings-primary-button'; switchButton.textContent = t('立即切换');
        const note = document.createElement('p'); actions.append(switchButton, note); status.after(actions);
        let switching = false;
        const assess = () => {
            const assessment = window.PiWorkbenchReload?.assess?.();
            return { blockers: Array.isArray(assessment?.blockers) ? assessment.blockers : [], restorable: assessment?.restorable || 0 };
        };
        const preservedDrafts = count => count > 0 ? t('未发送的文字草稿会在刷新后恢复（{0} 份）。', count) : '';
        const render = () => {
            select.value = preference();
            const pending = resolve(preference(), browserLanguages()) !== locale;
            const { blockers, restorable } = pending ? assess() : { blockers: [], restorable: 0 };
            actions.hidden = !pending || !blockers.length;
            note.textContent = [t('也可在下次刷新时应用语言。'), preservedDrafts(restorable)].filter(Boolean).join(' ');
            const text = pending ? blockers.length
                ? t('语言已保存。以下内容会受刷新影响：\n{0}', blockers.map(reason => '• ' + reason).join('\n'))
                : t('语言已保存，下次打开或刷新页面时生效。刷新前请保留草稿和附件；临时会话与侧聊会结束。')
                : t('跟随浏览器语言，也可为当前浏览器单独选择。界面语言不改变模型回复或朗读语言。');
            window.PiInlineStatus.show(status, { tone: pending && blockers.length ? 'warning' : 'info', text });
        };
        const reload = () => {
            if (switching) return;
            const target = resolve(preference(), browserLanguages());
            if (target === locale) return render();
            switching = true; select.disabled = true; switchButton.disabled = true;
            const overlay = document.createElement('div'); overlay.id = 'workspace-language-switch-overlay';
            overlay.setAttribute('role', 'status'); overlay.setAttribute('aria-busy', 'true'); overlay.lang = target;
            const mark = document.createElement('div'); mark.className = 'workspace-language-switch-mark';
            const spinner = document.createElement('span'); spinner.className = 'pi-spinner'; spinner.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            // This label intentionally uses the target language, independent of the frozen locale.
            label.textContent = target === 'zh-CN' ? '正在切换为简体中文…' : 'Switching to English…';
            mark.append(spinner, label); overlay.append(mark); document.body.append(overlay);
            // If another beforeunload handler cancels navigation, return to the saved/pending status.
            setTimeout(() => { overlay.remove(); switching = false; select.disabled = false; switchButton.disabled = false; render(); }, 4000);
            requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => {
                window.PiWorkbenchReload?.prepare?.();
                location.reload();
            }, 150)));
        };
        select.setAttribute('aria-label', t('界面语言'));
        select.options[0].textContent = t('跟随浏览器');
        render();
        select.addEventListener('change', () => {
            if (save(select.value)) {
                render();
                if (resolve(preference(), browserLanguages()) !== locale && !assess().blockers.length) reload();
            } else {
                select.value = preference(); actions.hidden = true;
                window.PiInlineStatus.show(status, { tone: 'error', text: t('浏览器无法保存语言设置，请检查网站存储权限。') });
            }
        });
        switchButton.addEventListener('click', () => {
            const { blockers, restorable } = assess();
            const text = t('立即切换语言并刷新页面？以下内容会受影响：\n{0}', blockers.map(reason => '• ' + reason).join('\n'));
            if (blockers.length && !confirm([text, preservedDrafts(restorable)].filter(Boolean).join('\n\n'))) return;
            reload();
        });
        window.addEventListener('storage', event => { if (event.key === KEY || event.key === null) render(); });
        window.addEventListener('languagechange', render);
    });
})();
