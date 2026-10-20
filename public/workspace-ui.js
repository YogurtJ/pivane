(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    // Presentation only: callers own request locks and stale-result checks.
    const pendingButtons = new WeakSet();
    window.PiActionFeedback = {
        begin(button, label, { iconOnly = false } = {}) {
            if (!button || pendingButtons.has(button)) return () => {};
            pendingButtons.add(button);
            const children = [...button.childNodes], disabled = button.disabled;
            const attributes = ['aria-busy', 'aria-label', 'title'].map(name => [name, button.getAttribute(name)]);
            const spinner = document.createElement('span');
            spinner.className = 'pi-spinner'; spinner.setAttribute('aria-hidden', 'true');
            button.replaceChildren(spinner);
            if (!iconOnly) button.append(document.createTextNode(label));
            button.classList.add('pi-action-pending'); button.disabled = true;
            button.setAttribute('aria-busy', 'true'); button.setAttribute('aria-label', label); button.title = label;
            let finished = false;
            return () => {
                if (finished) return;
                finished = true; pendingButtons.delete(button);
                button.replaceChildren(...children); button.disabled = disabled;
                button.classList.remove('pi-action-pending');
                for (const [name, value] of attributes) {
                    if (value === null) button.removeAttribute(name); else button.setAttribute(name, value);
                }
            };
        }
    };

    // Skeleton placeholders for lists and panels waiting for their first data.
    // Returns trusted static markup; the label is escaped. Variants: list, compact, lines, cards, chat, threads, projects.
    // decorative: true omits the status role when an outer element already announces the loading state.
    const SKELETON_WIDTHS = [68, 52, 74, 46, 60, 56, 70, 48];
    const escapeLabel = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.PiSkeleton = {
        html(variant = 'list', { rows = 4, label = translateUi('正在读取'), decorative = false } = {}) {
            const count = Math.max(1, Math.min(12, Number(rows) || 4));
            const width = (index, offset = 0) => SKELETON_WIDTHS[(index + offset) % SKELETON_WIDTHS.length];
            let body = '';
            if (variant === 'cards') {
                for (let i = 0; i < count; i++) body += `<span class="pv-skel-card"><span class="pv-skel-block"></span><span class="pv-skel-line" style="--w:${width(i)}%"></span><span class="pv-skel-line is-sub" style="--w:${width(i, 3)}%"></span><span class="pv-skel-line is-sub" style="--w:${width(i, 5) - 10}%"></span></span>`;
            } else if (variant === 'chat') {
                // Shaped like a real turn: a labelled question box, then a labelled answer.
                for (let i = 0; i < Math.min(count, 3); i++) body += `<span class="pv-skel-turn is-user"><span class="pv-skel-line is-tag"></span><span class="pv-skel-bubble"></span></span><span class="pv-skel-turn"><span class="pv-skel-line is-tag"></span><span class="pv-skel-line" style="--w:${Math.min(96, width(i, 2) + 26)}%"></span><span class="pv-skel-line" style="--w:${Math.min(92, width(i, 4) + 22)}%"></span><span class="pv-skel-line" style="--w:${width(i)}%"></span></span>`;
            } else if (variant === 'threads' || variant === 'projects') {
                // Session pane: optional project heading, then indented thread rows.
                if (variant === 'projects') body += '<span class="pv-skel-row is-head"><span class="pv-skel-icon"></span><span class="pv-skel-lines"><span class="pv-skel-line" style="--w:44%"></span></span></span>';
                for (let i = 0; i < count; i++) body += `<span class="pv-skel-row is-indent"><span class="pv-skel-lines"><span class="pv-skel-line" style="--w:${width(i)}%"></span><span class="pv-skel-line is-sub" style="--w:${width(i, 3) - 22}%"></span></span></span>`;
            } else {
                const icon = variant === 'lines' ? '' : '<span class="pv-skel-icon"></span>';
                for (let i = 0; i < count; i++) body += `<span class="pv-skel-row">${icon}<span class="pv-skel-lines"><span class="pv-skel-line" style="--w:${width(i)}%"></span>${variant === 'lines' ? '' : `<span class="pv-skel-line is-sub" style="--w:${width(i, 3) - 14}%"></span>`}</span></span>`;
            }
            const kind = ['list', 'compact', 'lines', 'cards', 'chat', 'threads', 'projects'].includes(variant) ? variant : 'list';
            const semantics = decorative ? 'aria-hidden="true"' : `role="status" aria-busy="true" aria-label="${escapeLabel(label)}"`;
            return `<div class="pv-skeleton pv-skeleton--${kind}" ${semantics}>${body}</div>`;
        }
    };

    // Inline status next to the control that caused it. Success hides itself by default;
    // errors and warnings stay until the next action replaces them.
    const statusTimers = new WeakMap();
    const STATUS_ICONS = { success: 'fa-circle-check', error: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation', info: 'fa-circle-info' };
    window.PiInlineStatus = {
        show(node, { tone = 'info', text = '', timeout } = {}) {
            if (!node) return;
            clearTimeout(statusTimers.get(node));
            node.classList.add('pv-inline-status'); node.classList.remove('is-leaving');
            if (!text) { node.hidden = true; node.replaceChildren(); return; }
            const mark = tone === 'pending' ? document.createElement('span') : document.createElement('i');
            if (tone === 'pending') mark.className = 'pi-spinner';
            else mark.className = `fa-solid ${STATUS_ICONS[tone] || STATUS_ICONS.info}`;
            mark.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span'); label.textContent = text;
            node.dataset.tone = tone; node.replaceChildren(mark, label); node.hidden = false;
            if (!node.hasAttribute('role')) node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
            const delay = timeout === undefined ? (tone === 'success' ? 6000 : 0) : timeout;
            if (delay > 0) statusTimers.set(node, setTimeout(() => {
                node.classList.add('is-leaving');
                statusTimers.set(node, setTimeout(() => { node.hidden = true; node.classList.remove('is-leaving'); }, 220));
            }, delay));
        },
        clear(node) { if (node) this.show(node, { text: '' }); }
    };

    const THEME_KEY = 'pi.workspace.theme';
    const SIDEBAR_KEY = 'pi.workspace.sidebarCollapsed';
    const SPLIT_PREFIX = 'pi.workspace.split:';
    const THEMES = new Set(['system', 'daylight', 'mint', 'slate', 'violet', 'dark']);
    const FONT_SIZE_KEY = 'pi.workspace.fontSize';
    const FONT_SIZES = Object.freeze({ small: '15px', default: '16px', large: '18px', xlarge: '20px' });
    const THEME_COLORS = {
        daylight: '#edf1ee',
        mint: '#eaf2ed',
        slate: '#edf2f8',
        violet: '#f3f0fa',
        dark: '#0d0f10'
    };

    function storedNumber(key, fallback) {
        const stored = localStorage.getItem(key);
        if (stored === null) return fallback;
        const value = Number(stored);
        return Number.isFinite(value) ? value : fallback;
    }

    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    document.addEventListener('DOMContentLoaded', () => {
        const app = document.querySelector('.app-container');
        const managementPage = document.getElementById('workspace-settings-dialog');
        if (app && managementPage) app.append(managementPage);
        const hostLabel = document.getElementById('workspace-host');
        if (hostLabel) hostLabel.textContent = window.location.host;
        const routeTabs = new Set(['chat', 'assistant', 'cron', 'artifacts', 'media', 'profiles', 'extensions', 'settings']);
        const settingsTabs = new Set(['providers', 'media', 'models', 'system-prompts', 'native', 'access', 'usage', 'updates']);
        const extensionTabs = new Set(['extensions', 'installed', 'mcp', 'channels']);
        const moreTabs = new Set(['cron', 'artifacts', 'media', 'profiles', 'extensions']);
        document.querySelectorAll('[data-cron-nav]').forEach(label => { label.textContent = translateUi('定时任务'); });
        const moreToggle = document.getElementById('workspace-more-toggle');
        const moreMenu = document.getElementById('workspace-more-menu');
        let lastConversation = '#/chat';
        let routeRevision = 0;
        const featureState = document.createElement('main');
        featureState.id = 'workspace-feature-state';
        featureState.className = 'content-area tab-content workspace-feature-state';
        featureState.setAttribute('aria-live', 'polite');
        app?.append(featureState);
        const featureText = (zh, en) => window.PiI18n?.locale === 'en' ? en : zh;
        function featureStatus(error, retry) {
            featureState.replaceChildren();
            const pageLoading = !error && parseRoute().tab === 'extensions';
            featureState.classList.toggle('is-page-loading', pageLoading);
            featureState.setAttribute('aria-busy', String(!error));
            if (pageLoading) {
                const page = document.createElement('div'); page.className = 'workspace-feature-page';
                const header = document.createElement('header'); header.className = 'workspace-feature-page-header';
                const title = document.createElement('h1'); title.textContent = featureText('扩展', 'Extensions');
                const status = document.createElement('p'); status.className = 'workspace-feature-page-status'; status.setAttribute('role', 'status');
                const spinner = document.createElement('span'); spinner.className = 'pi-spinner'; spinner.setAttribute('aria-hidden', 'true');
                status.append(spinner, document.createTextNode(featureText('正在加载扩展…', 'Loading extensions…')));
                header.append(title, status);
                const skeleton = document.createElement('div'); skeleton.className = 'workspace-feature-page-skeleton pv-skeleton'; skeleton.setAttribute('aria-hidden', 'true');
                skeleton.innerHTML = '<div class="workspace-feature-page-tabs"><span class="pv-skel-line"></span><span class="pv-skel-line"></span><span class="pv-skel-line"></span><span class="pv-skel-line"></span></div>'
                    + '<div class="workspace-feature-page-banner"><span class="pv-skel-icon"></span>' + window.PiSkeleton.html('lines', { rows: 2, decorative: true }) + '</div>'
                    + '<div class="workspace-feature-page-toolbar"><span class="pv-skel-line"></span><span class="pv-skel-line"></span></div>'
                    + window.PiSkeleton.html('cards', { rows: 6, decorative: true });
                page.append(header, skeleton); featureState.append(page);
                return;
            }
            const card = document.createElement('div');
            card.className = 'workspace-feature-card';
            const badge = document.createElement('span');
            badge.className = error ? 'workspace-feature-icon is-error' : 'workspace-feature-icon';
            if (error) {
                const icon = document.createElement('i'); icon.className = 'fa-solid fa-triangle-exclamation'; icon.setAttribute('aria-hidden', 'true');
                badge.append(icon);
            } else {
                const spinner = document.createElement('span'); spinner.className = 'pi-spinner'; spinner.setAttribute('aria-hidden', 'true');
                badge.append(spinner);
            }
            const message = document.createElement('p');
            message.textContent = error ? featureText('页面加载失败，请重试。', 'Unable to load this page. Please retry.') : featureText('正在读取…', 'Loading…');
            card.append(badge, message);
            if (!error && window.PiSkeleton) {
                const skeleton = document.createElement('div');
                skeleton.className = 'workspace-feature-skeleton';
                skeleton.innerHTML = window.PiSkeleton.html('lines', { rows: 3, decorative: true });
                card.append(skeleton);
            }
            if (error) {
                const button = document.createElement('button'); button.type = 'button';
                button.className = 'settings-secondary-button'; button.textContent = featureText('重试', 'Retry');
                button.addEventListener('click', retry, { once: true }); card.append(button);
            }
            featureState.append(card);
            featureState.setAttribute('aria-busy', String(!error));
        }
        // Dialog entry failures retain the conversation and offer an explicit retry.
        const featureError = document.createElement('dialog');
        featureError.className = 'workspace-feature-error';
        app?.append(featureError);
        window.PiFeatureFeedback = { show(error, retry) {
            featureError.replaceChildren();
            const message = document.createElement('p'); message.textContent = featureText('页面加载失败，请重试。', 'Unable to load this page. Please retry.');
            featureError.append(message);
            for (const [label, action] of [[featureText('重试', 'Retry'), retry], [featureText('关闭', 'Close'), () => {}]]) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-secondary-button'; button.textContent = label;
                button.addEventListener('click', () => { featureError.close(); action(); }); featureError.append(button);
            }
            if (!featureError.open) featureError.showModal();
        } };
        function closeMoreMenu(restoreFocus = false) {
            if (!moreMenu) return;
            const wasOpen = !moreMenu.hidden;
            moreMenu.hidden = true;
            moreToggle?.setAttribute('aria-expanded', 'false');
            if (restoreFocus && wasOpen) moreToggle?.focus({ preventScroll: true });
        }
        function parseRoute() {
            const match = /^#\/(chat|assistant|cron|artifacts|media|profiles|extensions|settings)(?:\?(.*))?$/.exec(location.hash);
            if (!match) return { tab: 'chat', params: new URLSearchParams() };
            return { tab: match[1], params: new URLSearchParams(match[2] || '') };
        }
        // Bookmarks written before installed packages and skills merged into one page keep working.
        function normalizeLegacySettingsRoute() {
            const { tab, params } = parseRoute();
            if (tab !== 'settings' && tab !== 'extensions') return;
            const inner = params.get('tab');
            let target = '';
            if (inner === 'profiles') target = '#/profiles';
            else if (inner === 'packages' || inner === 'skills') target = `#/extensions?tab=installed&type=${inner}`;
            else if (inner && extensionTabs.has(inner) && tab === 'settings') target = `#/extensions?${params}`;
            else if (tab === 'settings' && !settingsTabs.has(inner)) {
                params.set('tab', 'providers'); target = `#/settings?${params}`;
            }
            if (!target || target === location.hash) return;
            history.replaceState(null, '', target);
            window.dispatchEvent(new CustomEvent('workspace:settings-route-normalized', { detail: { from: tab, tab: inner } }));
        }
        function showRoute(completedRevision) {
            normalizeLegacySettingsRoute();
            const { tab, params } = parseRoute();
            const completion = typeof completedRevision === 'number';
            const revision = completion ? completedRevision : ++routeRevision;
            window.PiFeatures.routeChanged(revision);
            const routeKey = location.hash;
            const group = window.PiFeatures.routeGroup(tab);
            const pending = group && !window.PiFeatures.ready(group);
            closeMoreMenu();
            if (featureError.open) featureError.close();
            if (tab === 'chat' || tab === 'assistant') lastConversation = location.hash || '#/chat';
            moreToggle?.classList.toggle('active', moreTabs.has(tab));
            if (moreTabs.has(tab)) moreToggle?.setAttribute('aria-current', 'page'); else moreToggle?.removeAttribute('aria-current');
            moreMenu?.querySelectorAll('[data-more-tab]').forEach(button => {
                if (button.dataset.moreTab === tab) button.setAttribute('aria-current', 'page');
                else button.removeAttribute('aria-current');
            });
            document.querySelectorAll('.nav-btn[data-tab]').forEach(button => {
                const active = button.dataset.tab === tab;
                button.classList.toggle('active', active);
                if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
            });
            document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', pending ? panel === featureState : panel.id === `${tab === 'assistant' ? 'chat' : tab}-tab`));
            document.getElementById('workspace-settings-dialog')?.classList.toggle('hidden', pending || !['profiles', 'extensions', 'settings'].includes(tab));
            const settingsTab = tab === 'profiles' ? 'profiles'
                : tab === 'extensions' ? (extensionTabs.has(params.get('tab')) ? params.get('tab') : 'extensions')
                    : settingsTabs.has(params.get('tab')) ? params.get('tab') : 'providers';
            const settingsRoute = () => window.dispatchEvent(new CustomEvent('workspace:settings-route', { detail: { tab, settingsTab, revision, pending: Boolean(pending), profileId: params.get('profileId'), section: params.get('section'), authoringSession: params.get('authoringSession'), authoringCwd: params.get('authoringCwd'), resourceType: params.get('type') } }));
            if (pending) {
                featureStatus(null);
                settingsRoute();
                window.dispatchEvent(new CustomEvent('workspace:tabchanged', { detail: { tab: 'loading', params } }));
                void window.PiFeatures.ensure(group).then(() => {
                    if (revision === routeRevision && location.hash === routeKey) showRoute(revision);
                }).catch(error => {
                    if (revision === routeRevision && location.hash === routeKey) featureStatus(error, () => {
                        if (revision === routeRevision && location.hash === routeKey) showRoute(revision);
                    });
                });
                return;
            }
            if (group === 'settings') window.PiFeatures.applySettingsIntent(revision);
            window.dispatchEvent(new CustomEvent('workspace:tabchanged', { detail: { tab, params } }));
            if (!completion || group === 'settings') settingsRoute();
        }
        function routeHash(tab, params = {}) {
            if (!routeTabs.has(tab)) throw new Error('Unknown workspace route');
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(params)) if (value != null && value !== '') query.set(key, value);
            if (tab === 'settings' && !settingsTabs.has(query.get('tab'))) query.set('tab', 'providers');
            return `#/${tab}${query.size ? `?${query}` : ''}`;
        }
        function navigate(tab, params = {}, replace = false) {
            const hash = routeHash(tab, params);
            if (location.hash === hash) return showRoute();
            if (replace) history.replaceState(null, '', hash);
            else history.pushState(null, '', hash);
            showRoute();
        }
        window.PiWorkspaceRoute = Object.freeze({ navigate, current: parseRoute, revision: () => routeRevision,
            rememberConversation(tab, params) { if (tab === 'chat' || tab === 'assistant') lastConversation = routeHash(tab, params); },
            returnToConversation: () => {
            const url = ['chat', 'assistant'].includes(parseRoute().tab) ? location.hash : lastConversation;
            history.pushState(null, '', url); showRoute();
        } });
        window.addEventListener('popstate', showRoute);
        window.addEventListener('hashchange', showRoute);
        document.querySelectorAll('.nav-btn[data-tab]').forEach(button => {
            button.addEventListener('click', () => navigate(button.dataset.tab));
        });
        moreToggle?.addEventListener('click', () => {
            const opening = moreMenu.hidden;
            closeThemeMenu();
            moreMenu.hidden = !opening;
            moreToggle.setAttribute('aria-expanded', String(opening));
            if (opening) moreMenu.querySelector('button')?.focus({ preventScroll: true });
        });
        moreMenu?.addEventListener('click', event => {
            const button = event.target.closest('[data-more-tab]');
            if (button) {
                navigate(button.dataset.moreTab);
                moreToggle?.focus({ preventScroll: true });
            }
        });
        moreMenu?.addEventListener('keydown', event => {
            const items = [...moreMenu.querySelectorAll('[data-more-tab]')];
            const index = items.indexOf(document.activeElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
                : event.key === 'ArrowDown' ? (index + 1) % items.length
                    : event.key === 'ArrowUp' ? (index + items.length - 1) % items.length : -1;
            if (next < 0) return;
            event.preventDefault();
            items[next].focus();
        });
        window.matchMedia('(max-width: 680px)').addEventListener('change', () => closeMoreMenu());
        showRoute();
        const sidebarToggle = document.getElementById('workspace-sidebar-toggle');
        const brandToggle = document.getElementById('workspace-brand-toggle');
        const themeToggle = document.getElementById('workspace-theme-toggle');
        const themeMenu = document.getElementById('workspace-theme-menu');
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
        const mobileMedia = window.matchMedia('(max-width: 900px)');
        const syncBrandToggle = () => { if (brandToggle) brandToggle.disabled = mobileMedia.matches; };
        syncBrandToggle();
        mobileMedia.addEventListener('change', syncBrandToggle);
        const touchMedia = window.matchMedia('(hover: none) and (pointer: coarse)');
        const viewport = window.visualViewport;
        const pageIsZoomed = () => (viewport?.scale || 1) > 1.01;
        const syncPageZoom = () => document.documentElement.classList.toggle('workspace-browser-zoomed', pageIsZoomed());
        syncPageZoom();
        viewport?.addEventListener('resize', syncPageZoom);

        // Safari emits GestureEvents separately from CSS touch-action. Do not trap an already zoomed page.
        let blockPageGesture = false;
        document.addEventListener('gesturestart', event => {
            blockPageGesture = touchMedia.matches && !pageIsZoomed();
            if (blockPageGesture && event.cancelable) event.preventDefault();
        }, { passive: false });
        document.addEventListener('gesturechange', event => {
            if (blockPageGesture && event.cancelable) event.preventDefault();
        }, { passive: false });
        document.addEventListener('gestureend', () => { blockPageGesture = false; });

        function setSidebarCollapsed(collapsed, persist = true) {
            app?.classList.toggle('sidebar-collapsed', collapsed);
            for (const button of [sidebarToggle, brandToggle]) {
                if (!button) continue;
                button.setAttribute('aria-expanded', String(!collapsed));
                button.title = collapsed ? translateUi("展开导航") : translateUi("折叠导航");
                button.setAttribute('aria-label', button.title);
            }
            if (persist) localStorage.setItem(SIDEBAR_KEY, String(collapsed));
            window.setTimeout(() => window.dispatchEvent(new Event('resize')), 180);
        }

        function setTheme(theme, persist = true) {
            const preference = THEMES.has(theme) ? theme : 'system';
            const selected = preference === 'system'
                ? (systemThemeMedia.matches ? 'dark' : 'daylight')
                : preference;
            document.documentElement.dataset.theme = selected;
            if (persist) localStorage.setItem(THEME_KEY, preference);
            if (themeMeta) themeMeta.content = THEME_COLORS[selected];
            themeMenu?.querySelectorAll('[data-theme]').forEach(button => {
                button.setAttribute('aria-checked', String(button.dataset.theme === preference));
            });
            document.querySelectorAll('[data-appearance-theme]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.appearanceTheme === preference));
            });
        }

        function setFontSize(size, persist = true) {
            const preference = Object.hasOwn(FONT_SIZES, size) ? size : 'default';
            document.documentElement.style.fontSize = FONT_SIZES[preference];
            if (persist) localStorage.setItem(FONT_SIZE_KEY, preference);
            document.querySelectorAll('[data-font-size]').forEach(button => {
                button.setAttribute('aria-pressed', String(button.dataset.fontSize === preference));
            });
            window.dispatchEvent(new Event('resize'));
        }

        setTheme(localStorage.getItem(THEME_KEY) || 'system', false);
        setFontSize(localStorage.getItem(FONT_SIZE_KEY), false);
        document.getElementById('appearance-themes')?.addEventListener('click', event => {
            const button = event.target.closest('[data-appearance-theme]');
            if (button) setTheme(button.dataset.appearanceTheme);
        });
        document.getElementById('appearance-font-sizes')?.addEventListener('click', event => {
            const button = event.target.closest('[data-font-size]');
            if (button) setFontSize(button.dataset.fontSize);
        });
        window.addEventListener('storage', event => {
            if (event.key === THEME_KEY || event.key === null) setTheme(localStorage.getItem(THEME_KEY) || 'system', false);
            if (event.key === FONT_SIZE_KEY || event.key === null) setFontSize(localStorage.getItem(FONT_SIZE_KEY), false);
        });
        const onSystemThemeChange = () => {
            if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') setTheme('system', false);
        };
        if (systemThemeMedia.addEventListener) systemThemeMedia.addEventListener('change', onSystemThemeChange);
        else systemThemeMedia.addListener?.(onSystemThemeChange);

        function closeThemeMenu() {
            themeMenu?.classList.add('hidden');
            themeToggle?.setAttribute('aria-expanded', 'false');
        }

        setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) !== 'false', false);

        for (const button of [sidebarToggle, brandToggle]) {
            button?.addEventListener('click', () => {
                setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'));
            });
        }

        themeToggle?.addEventListener('click', event => {
            event.stopPropagation();
            closeMoreMenu();
            const opening = themeMenu?.classList.contains('hidden');
            themeMenu?.classList.toggle('hidden', !opening);
            themeToggle.setAttribute('aria-expanded', String(opening));
            if (opening) themeMenu?.querySelector('[aria-checked="true"]')?.focus();
        });

        themeMenu?.addEventListener('click', event => {
            const button = event.target.closest('[data-theme]');
            if (!button) return;
            setTheme(button.dataset.theme);
            closeThemeMenu();
            themeToggle?.focus();
        });

        document.addEventListener('click', event => {
            if (!event.target.closest('.theme-picker')) closeThemeMenu();
            if (!event.target.closest('#workspace-more-toggle, #workspace-more-menu')) closeMoreMenu();
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                closeThemeMenu();
                closeMoreMenu(true);
            }
        });

        document.querySelectorAll('[data-split-handle]').forEach(handle => {
            const container = handle.parentElement;
            const target = container?.querySelector(handle.dataset.splitTarget);
            if (!container || !target) return;

            const key = `${SPLIT_PREFIX}${handle.dataset.splitKey}`;
            const defaultSize = Number(handle.dataset.default) || 320;
            const minSize = Number(handle.dataset.min) || 220;
            const configuredMax = Number(handle.dataset.max) || 720;
            const direction = handle.dataset.splitEdge === 'right' ? -1 : 1;
            let preferredSize = storedNumber(key, defaultSize);
            // Expanded reading has a page-local width; it must not replace the
            // browser's saved width for details, history and side chat.
            let expandedReadingSize = 1120;
            const expandedReading = () => target.id === 'pi-inspector' && target.classList.contains('show-changes') && target.classList.contains('files-expanded');
            let currentSize = preferredSize;
            let draggingPointerId = null;
            let dragStart = null;

            function availableMax() {
                const containerWidth = container.getBoundingClientRect().width;
                if (container.classList.contains('pi-workbench') && containerWidth) {
                    const occupied = [...container.children].filter(node => node !== target && !node.classList.contains('pi-transcript-shell')
                        && !(target.id === 'pi-session-pane' && ['pi-inspector', 'pi-inspector-split'].includes(node.id))
                        && getComputedStyle(node).position !== 'absolute').reduce((total, node) => total + node.getBoundingClientRect().width, 0);
                    // Fit every desktop tool against the main conversation. File
                    // expansion uses the same splitter with a larger reading limit.
                    if (target.id === 'pi-inspector') {
                        const max = expandedReading() ? 1120 : configuredMax;
                        return Math.max(minSize, Math.min(max, containerWidth - occupied - 480));
                    }
                    const reserve = target.id === 'pi-session-pane' && container.querySelector('#pi-inspector.open') ? 480 + 280 + 6 : 600;
                    return Math.max(minSize, Math.min(configuredMax, containerWidth - occupied - reserve));
                }
                if (containerWidth < minSize + 320) return configuredMax;
                return Math.max(minSize, Math.min(configuredMax, containerWidth - 320));
            }

            function applySize(size, persist = false) {
                currentSize = clamp(Math.round(size), minSize, availableMax());
                target.style.setProperty('--split-size', `${currentSize}px`);
                handle.setAttribute('aria-valuemin', String(minSize));
                handle.setAttribute('aria-valuemax', String(Math.round(availableMax())));
                handle.setAttribute('aria-valuenow', String(currentSize));
                if (persist) {
                    if (expandedReading()) expandedReadingSize = currentSize;
                    else {
                        preferredSize = currentSize;
                        localStorage.setItem(key, String(currentSize));
                    }
                }
            }

            applySize(currentSize);
            // Refit both desktop panels when the drawer, navigation or viewport changes.
            // Defer writes out of ResizeObserver delivery to avoid resize-loop errors.
            let resizeFrame = null;
            const scheduleSize = () => {
                if (resizeFrame !== null) return;
                resizeFrame = requestAnimationFrame(() => {
                    resizeFrame = null;
                    if (mobileMedia.matches || getComputedStyle(target).display === 'none') {
                        if (draggingPointerId !== null) finishResize({ pointerId: draggingPointerId });
                        return;
                    }
                    if (draggingPointerId === null) applySize(expandedReading() ? expandedReadingSize : preferredSize);
                });
            };
            const resizeObserver = new ResizeObserver(scheduleSize);
            resizeObserver.observe(container);
            for (const node of container.children) resizeObserver.observe(node);
            new MutationObserver(scheduleSize).observe(target, { attributes: true, attributeFilter: ['class'] });
            mobileMedia.addEventListener('change', scheduleSize);

            handle.addEventListener('pointerdown', event => {
                if (mobileMedia.matches || event.button !== 0) return;
                event.preventDefault();
                handle.setPointerCapture(event.pointerId);
                draggingPointerId = event.pointerId;
                dragStart = { x: event.clientX, size: currentSize };
                document.body.classList.add('is-resizing');
            });

            handle.addEventListener('pointermove', event => {
                if (draggingPointerId !== event.pointerId) return;
                applySize(dragStart.size + (event.clientX - dragStart.x) * direction);
            });

            function finishResize(event) {
                if (draggingPointerId !== event.pointerId) return;
                draggingPointerId = null;
                if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
                document.body.classList.remove('is-resizing');
                applySize(currentSize, true);
            }

            handle.addEventListener('pointerup', finishResize);
            handle.addEventListener('pointercancel', finishResize);
            handle.addEventListener('lostpointercapture', () => {
                if (draggingPointerId === null) return;
                draggingPointerId = null;
                document.body.classList.remove('is-resizing');
                applySize(currentSize, true);
            });
            handle.addEventListener('dblclick', () => applySize(defaultSize, true));
            handle.addEventListener('keydown', event => {
                let next = currentSize;
                if (event.key === 'ArrowLeft') next -= (event.shiftKey ? 48 : 16) * direction;
                else if (event.key === 'ArrowRight') next += (event.shiftKey ? 48 : 16) * direction;
                else if (event.key === 'Home') next = minSize;
                else if (event.key === 'End') next = availableMax();
                else return;
                event.preventDefault();
                applySize(next, true);
            });
        });

        const workbench = document.querySelector('.pi-workbench');
        const sessionPane = document.getElementById('pi-session-pane');
        const inspector = document.getElementById('pi-inspector');
        if (workbench && sessionPane && inspector) {
            const scrim = document.createElement('button');
            scrim.type = 'button';
            scrim.className = 'pi-drawer-scrim hidden';
            scrim.setAttribute('aria-label', 'Close panel');
            workbench.appendChild(scrim);

            const syncScrim = () => {
                const open = mobileMedia.matches && sessionPane.classList.contains('open')
                    || (mobileMedia.matches || workbench.classList.contains('pi-inspector-overlay')) && inspector.classList.contains('open');
                scrim.classList.toggle('hidden', !open);
            };
            const observer = new MutationObserver(syncScrim);
            observer.observe(sessionPane, { attributes: true, attributeFilter: ['class'] });
            observer.observe(inspector, { attributes: true, attributeFilter: ['class'] });
            mobileMedia.addEventListener('change', syncScrim);
            scrim.addEventListener('click', () => {
                sessionPane.classList.remove('open');
                inspector.classList.remove('open');
            });
            syncScrim();
        }

        document.querySelectorAll('.nav-btn').forEach(button => {
            button.addEventListener('click', () => {
                if (!mobileMedia.matches) return;
                document.getElementById('pi-session-pane')?.classList.remove('open');
                document.getElementById('pi-inspector')?.classList.remove('open');
            });
        });
    });
})();
