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

    const THEME_KEY = 'pi.workspace.theme';
    const SIDEBAR_KEY = 'pi.workspace.sidebarCollapsed';
    const SPLIT_PREFIX = 'pi.workspace.split:';
    const THEMES = new Set(['system', 'daylight', 'mint', 'dark']);
    const THEME_COLORS = {
        daylight: '#f7f9fc',
        mint: '#f4f8f5',
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
        const routeTabs = new Set(['chat', 'assistant', 'media', 'profiles', 'extensions', 'settings']);
        const settingsTabs = new Set(['providers', 'media', 'models', 'system-prompts', 'native', 'access', 'usage', 'updates']);
        const extensionTabs = new Set(['extensions', 'packages', 'skills']);
        const moreTabs = new Set(['media', 'profiles', 'extensions']);
        const moreToggle = document.getElementById('workspace-more-toggle');
        const moreMenu = document.getElementById('workspace-more-menu');
        let lastConversation = '#/chat';
        function closeMoreMenu(restoreFocus = false) {
            if (!moreMenu) return;
            const wasOpen = !moreMenu.hidden;
            moreMenu.hidden = true;
            moreToggle?.setAttribute('aria-expanded', 'false');
            if (restoreFocus && wasOpen) moreToggle?.focus({ preventScroll: true });
        }
        function parseRoute() {
            const match = /^#\/(chat|assistant|media|profiles|extensions|settings)(?:\?(.*))?$/.exec(location.hash);
            if (!match) return { tab: 'chat', params: new URLSearchParams() };
            return { tab: match[1], params: new URLSearchParams(match[2] || '') };
        }
        function showRoute() {
            const { tab, params } = parseRoute();
            closeMoreMenu();
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
            document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === `${tab === 'assistant' ? 'chat' : tab}-tab`));
            document.getElementById('workspace-settings-dialog')?.classList.toggle('hidden', !['profiles', 'extensions', 'settings'].includes(tab));
            window.dispatchEvent(new CustomEvent('workspace:tabchanged', { detail: { tab, params } }));
            const settingsTab = tab === 'profiles' ? 'profiles'
                : tab === 'extensions' ? (extensionTabs.has(params.get('tab')) ? params.get('tab') : 'extensions')
                    : settingsTabs.has(params.get('tab')) ? params.get('tab') : 'providers';
            window.dispatchEvent(new CustomEvent('workspace:settings-route', { detail: { tab, settingsTab, profileId: params.get('profileId'), section: params.get('section'), authoringSession: params.get('authoringSession'), authoringCwd: params.get('authoringCwd') } }));
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
        window.PiWorkspaceRoute = Object.freeze({ navigate, current: parseRoute,
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

        function setSidebarCollapsed(collapsed) {
            app?.classList.toggle('sidebar-collapsed', collapsed);
            for (const button of [sidebarToggle, brandToggle]) {
                if (!button) continue;
                button.setAttribute('aria-expanded', String(!collapsed));
                button.title = collapsed ? translateUi("展开导航") : translateUi("折叠导航");
                button.setAttribute('aria-label', button.title);
            }
            localStorage.setItem(SIDEBAR_KEY, String(collapsed));
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
        }

        const savedTheme = localStorage.getItem(THEME_KEY);
        setTheme(savedTheme || 'system');
        const onSystemThemeChange = () => {
            if ((localStorage.getItem(THEME_KEY) || 'system') === 'system') setTheme('system', false);
        };
        if (systemThemeMedia.addEventListener) systemThemeMedia.addEventListener('change', onSystemThemeChange);
        else systemThemeMedia.addListener?.(onSystemThemeChange);

        function closeThemeMenu() {
            themeMenu?.classList.add('hidden');
            themeToggle?.setAttribute('aria-expanded', 'false');
        }

        setSidebarCollapsed(localStorage.getItem(SIDEBAR_KEY) === 'true');

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
            let currentSize = preferredSize;
            let draggingPointerId = null;
            let dragStart = null;

            function availableMax() {
                const containerWidth = container.getBoundingClientRect().width;
                if (container.classList.contains('pi-workbench') && containerWidth) {
                    const occupied = [...container.children].filter(node => node !== target && !node.classList.contains('pi-transcript-shell')
                        && getComputedStyle(node).position !== 'absolute').reduce((total, node) => total + node.getBoundingClientRect().width, 0);
                    return Math.max(minSize, Math.min(configuredMax, containerWidth - occupied - 360));
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
                    preferredSize = currentSize;
                    localStorage.setItem(key, String(currentSize));
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
                    if (draggingPointerId === null) applySize(preferredSize);
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
                const open = mobileMedia.matches
                    && (sessionPane.classList.contains('open') || inspector.classList.contains('open'));
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
