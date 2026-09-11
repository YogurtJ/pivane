(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
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
        const hostLabel = document.getElementById('workspace-host');
        if (hostLabel) hostLabel.textContent = window.location.host;
        document.querySelectorAll('.nav-btn[data-tab]').forEach(button => {
            button.addEventListener('click', () => {
                document.querySelectorAll('.nav-btn[data-tab]').forEach(item => item.classList.toggle('active', item === button));
                document.querySelectorAll('.tab-content').forEach(panel => panel.classList.toggle('active', panel.id === `${button.dataset.tab}-tab`));
                window.dispatchEvent(new CustomEvent('workspace:tabchanged', { detail: { tab: button.dataset.tab } }));
            });
        });
        const sidebarToggle = document.getElementById('workspace-sidebar-toggle');
        const themeToggle = document.getElementById('workspace-theme-toggle');
        const themeMenu = document.getElementById('workspace-theme-menu');
        const themeMeta = document.querySelector('meta[name="theme-color"]');
        const systemThemeMedia = window.matchMedia('(prefers-color-scheme: dark)');
        const mobileMedia = window.matchMedia('(max-width: 900px)');
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
            sidebarToggle?.setAttribute('aria-expanded', String(!collapsed));
            if (sidebarToggle) {
                sidebarToggle.title = collapsed ? translateUi("展开导航") : translateUi("折叠导航");
                sidebarToggle.setAttribute('aria-label', sidebarToggle.title);
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

        sidebarToggle?.addEventListener('click', () => {
            setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'));
        });

        themeToggle?.addEventListener('click', event => {
            event.stopPropagation();
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
        });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') closeThemeMenu();
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
