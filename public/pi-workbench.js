/* Workbench presentation: responsive panel placement and discoverable controls.
 * Runtime/session state and the actual tool panels remain with their owners. */
(() => {
    const t = (text, ...values) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(text, ...values) : text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? '');
    const $ = id => document.getElementById(id);
    const button = (id, label, icon) => {
        const node = document.createElement('button'); node.type = 'button'; node.id = id; node.title = label;
        node.setAttribute('aria-label', label);
        const mark = document.createElement('i'); mark.className = `fa-solid fa-${icon}`; mark.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span'); text.textContent = label; node.append(mark, text); return node;
    };
    document.addEventListener('DOMContentLoaded', () => {
        const workbench = document.querySelector('.pi-workbench');
        const inspector = $('pi-inspector'), sessions = $('pi-session-pane'), transcript = document.querySelector('.pi-transcript-shell');
        const headerControls = document.querySelector('.pi-runtime-controls');
        const modelBar = document.createElement('div'); modelBar.className = 'pi-composer-models';
        modelBar.append(document.querySelector('.pi-model-field'), document.querySelector('.pi-thinking-field'));
        modelBar.querySelector('#pi-thinking-select').setAttribute('aria-label', t('思考'));
        document.querySelector('.pi-composer-actions.right').before(modelBar); // Keep keyboard order aligned with visual order; move, never copy controls.
        const navLabels = { chat: t('工作'), assistant: t('助手'), cron: t('定时'), media: t('创作'), profiles: t('身份'), extensions: t('扩展') };
        document.querySelectorAll('.nav-btn[data-tab]').forEach(node => {
            const short = document.createElement('span'); short.className = 'workspace-nav-short'; short.textContent = navLabels[node.dataset.tab];
            node.append(short);
            if (!node.title) node.title = node.querySelector('span')?.textContent || short.textContent;
            node.setAttribute('aria-label', node.title);
        });
        $('pi-session-filters').querySelector('[data-filter="all"]').textContent = t('项目');
        $('pi-session-filters').querySelector('[data-filter="work"]').textContent = t('动态');
        $('pi-assistant-switcher').querySelector('label').textContent = t('助手身份');
        const searchText = document.createElement('span'); searchText.textContent = t('搜正文'); $('pi-search-conversations').append(searchText);
        $('pi-session-search').placeholder = t('搜索项目与线程标题');
        $('pi-session-search').setAttribute('aria-label', t('搜索项目与线程标题'));
        const newText = document.createElement('span'); newText.className = 'pi-new-session-label'; newText.textContent = t('新建线程'); $('pi-new-session').append(newText);
        $('pi-new-session').setAttribute('aria-label', t('新建线程')); $('pi-new-session').title = t('在当前项目新建线程');
        const openProject = button('pi-open-project', t('打开项目目录'), 'folder-open'); openProject.className = 'icon-btn subtle';
        openProject.addEventListener('click', () => $('pi-project-button').click());
        document.querySelector('.pi-session-heading .pi-pane-actions').prepend(openProject);
        const closeSessions = button('pi-close-sessions', t('关闭项目与线程'), 'xmark'); closeSessions.className = 'icon-btn subtle';
        closeSessions.addEventListener('click', () => sessions.classList.remove('open')); document.querySelector('.pi-session-heading .pi-pane-actions').append(closeSessions);

        const rail = document.createElement('nav'); rail.className = 'pi-tool-rail'; rail.setAttribute('aria-label', t('当前线程工具'));
        const tools = [
            ['changes', 'pi-changes-tab', t('文件'), 'file-lines'], ['tasks', 'pi-tasks-tab', t('任务'), 'list-check'],
            ['history', 'pi-history-tab', t('历史'), 'clock-rotate-left'], ['side', 'pi-side-tab', t('侧聊'), 'comment-dots'],
            ['details', 'pi-details-tab', t('详情'), 'circle-info']
        ];
        $('pi-tasks-tab').textContent = t('任务');
        $('pi-task-dock-empty').textContent = t('任务开始后，这里会显示计划、子 Agent 和返回结果。');
        // Tool owners initialize or resume their own context; the layout never caches reader state.
        const selectTool = (_mode, id) => $(id).click();
        const toolButtons = tools.map(([mode, id, label, icon]) => {
            const node = button(`pi-tool-${mode}`, label, icon); node.dataset.toolPane = mode;
            node.setAttribute('aria-controls', 'pi-inspector'); node.setAttribute('aria-expanded', 'false');
            node.addEventListener('click', () => {
                const tab = $(id);
                if (inspector.classList.contains('open') && tab.getAttribute('aria-selected') === 'true') inspector.classList.remove('open');
                else selectTool(mode, id);
            }); rail.append(node); return node;
        });
        workbench.append(rail);
        const toolsToggle = button('pi-tools-toggle', t('当前线程工具'), 'table-columns'); toolsToggle.className = 'icon-btn pi-tools-toggle';
        toolsToggle.setAttribute('aria-haspopup', 'dialog'); headerControls.append(toolsToggle);
        const toolsDialog = document.createElement('dialog'); toolsDialog.className = 'pi-tools-dialog'; toolsDialog.id = 'pi-tools-dialog';
        toolsDialog.setAttribute('aria-label', t('当前线程工具'));
        const dialogHead = document.createElement('header'), dialogTitle = document.createElement('strong'); dialogTitle.textContent = t('当前线程工具');
        const dialogClose = button('pi-tools-close', t('关闭'), 'xmark'); dialogClose.className = 'icon-btn subtle'; dialogClose.addEventListener('click', () => toolsDialog.close());
        dialogHead.append(dialogTitle, dialogClose); toolsDialog.append(dialogHead);
        const mobileTools = tools.map(([mode, id, label, icon]) => {
            const node = button(`pi-mobile-tool-${mode}`, label, icon);
            node.addEventListener('click', () => { toolsDialog.close(); toolsToggle.focus({ preventScroll: true }); selectTool(mode, id); }); toolsDialog.append(node); return node;
        });
        document.body.append(toolsDialog); toolsToggle.addEventListener('click', () => { syncTools(); toolsDialog.showModal(); });
        toolsDialog.addEventListener('close', () => { if (!inspector.classList.contains('open')) toolsToggle.focus({ preventScroll: true }); });
        const inspectorTitle = document.createElement('select'); inspectorTitle.id = 'pi-inspector-title';
        inspectorTitle.setAttribute('aria-label', t('当前线程工具'));
        for (const [mode, , label] of tools) inspectorTitle.add(new Option(label, mode));
        inspectorTitle.addEventListener('change', () => selectTool(...tools.find(([mode]) => mode === inspectorTitle.value)));
        document.querySelector('.inspector-heading').prepend(inspectorTitle);
        let frame = 0, modal = null, returnFocus = null, lastOutsideFocus = null, inspectorWasOpen = false, inspectorReturnFocus = null;
        document.addEventListener('focusin', event => {
            if (!inspector.contains(event.target) && !sessions.contains(event.target) && !event.target.closest('dialog')) lastOutsideFocus = event.target;
        });
        const setHidden = (node, value) => { if (node.hidden !== value) node.hidden = value; };
        function syncTools() {
            tools.forEach(([mode, id], index) => {
                const tab = $(id), unavailable = tab.hidden;
                setHidden(toolButtons[index], unavailable); setHidden(mobileTools[index], unavailable);
                const selected = !unavailable && inspector.classList.contains('open') && tab.getAttribute('aria-selected') === 'true';
                toolButtons[index].disabled = mobileTools[index].disabled = tab.disabled;
                const expanded = String(selected);
                if (toolButtons[index].getAttribute('aria-expanded') !== expanded) toolButtons[index].setAttribute('aria-expanded', expanded);
                const option = inspectorTitle.options[index]; option.hidden = unavailable; option.disabled = unavailable || tab.disabled;
                if (selected && inspectorTitle.value !== mode) inspectorTitle.value = mode;
            });
            const unavailable = $('pi-project-button').hidden;
            setHidden(openProject, unavailable);
        }
        function syncLayout() {
            frame = 0; syncTools();
            const mobile = innerWidth <= 900;
            const width = workbench.getBoundingClientRect().width;
            const sessionWidth = mobile ? 0 : sessions.getBoundingClientRect().width;
            const preferred = parseFloat(inspector.style.getPropertyValue('--split-size')) || 336;
            const expanded = inspector.classList.contains('files-expanded') && inspector.classList.contains('show-changes');
            const overlay = mobile || expanded || width - sessionWidth - preferred - 62 < 600;
            workbench.classList.toggle('pi-inspector-overlay', overlay);
            const open = inspector.classList.contains('open');
            if (open && !inspectorWasOpen) inspectorReturnFocus = inspector.contains(document.activeElement) ? lastOutsideFocus : document.activeElement;
            const inspectorClosed = !open && inspectorWasOpen;
            inspectorWasOpen = open;
            const active = $('chat-tab').classList.contains('active');
            const nextModal = !active ? null : mobile && sessions.classList.contains('open') ? sessions : open && overlay ? inspector : null;
            const scrim = workbench.querySelector('.pi-drawer-scrim');
            scrim?.classList.toggle('hidden', !nextModal);
            if (nextModal !== modal) {
                if (modal) { modal.removeAttribute('role'); modal.removeAttribute('aria-modal'); modal.removeAttribute('aria-label'); }
                if (nextModal) {
                    nextModal.inert = false;
                    if (!modal) returnFocus = nextModal.contains(document.activeElement) ? lastOutsideFocus : document.activeElement;
                    nextModal.setAttribute('role', 'dialog'); nextModal.setAttribute('aria-modal', 'true');
                    nextModal.setAttribute('aria-label', nextModal === sessions ? t('项目与线程') : t('当前线程工具'));
                    // Do not steal focus from the file/side-chat owner if it already moved inside.
                    if (!nextModal.contains(document.activeElement)) (nextModal === sessions ? closeSessions : $('pi-close-inspector')).focus({ preventScroll: true });
                }
                const previous = modal;
                modal = nextModal;
                if (!modal && previous) {
                    // Remove inert before restoring focus; focusing an inert background is ignored.
                    document.querySelector('.pi-command-bar').inert = false;
                    $('workspace-sidebar').inert = false; transcript.inert = false; sessions.inert = false; rail.inert = false; inspector.inert = false;
                    if (!document.querySelector('dialog[open]')) {
                        const fallback = previous === sessions ? $('pi-toggle-sessions') : innerWidth <= 900 ? toolsToggle : toolButtons.find(node => node.getAttribute('aria-expanded') === 'true') || toolButtons.find(node => !node.hidden);
                        const current = document.activeElement;
                        const target = current !== document.body && !previous.contains(current) && current.getClientRects().length ? current
                            : returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : fallback;
                        target?.focus({ preventScroll: true });
                    }
                    returnFocus = null;
                }
            }
            document.querySelector('.pi-command-bar').inert = Boolean(modal);
            $('workspace-sidebar').inert = Boolean(modal);
            transcript.inert = Boolean(modal);
            sessions.inert = Boolean(modal && modal !== sessions) || mobile && !sessions.classList.contains('open');
            rail.inert = Boolean(modal);
            inspector.inert = Boolean(modal && modal !== inspector);
            if (inspectorClosed && !modal && !document.querySelector('dialog[open]')) {
                if (document.activeElement === document.body || inspector.contains(document.activeElement)) {
                    const target = inspectorReturnFocus?.isConnected && inspectorReturnFocus.getClientRects().length ? inspectorReturnFocus : innerWidth <= 900 ? toolsToggle : $('pi-tool-details');
                    target?.focus({ preventScroll: true });
                }
                inspectorReturnFocus = null;
            }
        }
        function schedule() { if (!frame) frame = requestAnimationFrame(syncLayout); }
        new ResizeObserver(schedule).observe(workbench);
        new ResizeObserver(schedule).observe(sessions);
        const layoutChanged = () => { if (frame) cancelAnimationFrame(frame); syncLayout(); };
        new MutationObserver(layoutChanged).observe(inspector, { attributes: true, attributeFilter: ['class', 'style'] });
        new MutationObserver(layoutChanged).observe(sessions, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(schedule).observe($('pi-inspector-tabs'), { subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'aria-selected'] });
        new MutationObserver(schedule).observe($('pi-project-button'), { attributes: true, attributeFilter: ['hidden'] });
        window.addEventListener('resize', schedule);
        window.addEventListener('workspace:tabchanged', () => {
            if (!$('chat-tab').classList.contains('active')) { inspector.classList.remove('open'); sessions.classList.remove('open'); }
            layoutChanged();
        });
        document.addEventListener('keydown', event => {
            if (event.isComposing || event.defaultPrevented || document.querySelector('dialog[open], .pi-thread-menu:not(.hidden), .pi-quote-menu:not(.hidden)')) return;
            if (event.key === 'Escape' && sessions.contains(event.target) && !$('pi-session-search-field').hidden) return;
            if (event.key === 'Escape' && inspector.classList.contains('open')) { event.preventDefault(); inspector.classList.remove('open'); }
            else if (event.key === 'Escape' && sessions.classList.contains('open')) { event.preventDefault(); sessions.classList.remove('open'); }
            if (event.key !== 'Tab' || !modal) return;
            const focusable = [...modal.querySelectorAll('button, input, select, textarea, summary, a[href], [tabindex]')].filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');
            if (!focusable.length) return;
            if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable.at(-1).focus(); }
            else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { event.preventDefault(); focusable[0].focus(); }
        });
        document.addEventListener('keydown', event => {
            if (event.isComposing || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k' || document.querySelector('dialog[open]')) return;
            if (!$('chat-tab').classList.contains('active')) return;
            event.preventDefault();
            inspector.classList.remove('open');
            if (innerWidth <= 900 && !sessions.classList.contains('open')) $('pi-toggle-sessions').click();
            if ($('pi-session-search-field').hidden) $('pi-session-search-toggle').click();
            queueMicrotask(() => $('pi-session-search').focus({ preventScroll: true }));
        });
        // Task cards move into the dock, retaining their own state, controls and identity.
        const chips = $('pi-composer-chips'), dock = $('pi-task-dock');
        const originalCards = [...chips.children];
        let docked = false;
        const hiddenCards = new Map(originalCards.map(card => [card, card.hidden]));
        const syncDock = () => {
            const visible = inspector.classList.contains('open') && !$('pi-inspector-tasks').hidden;
            if (visible !== docked) {
                docked = visible;
                for (const card of originalCards) {
                    if (visible) { card.dataset.wasOpen = String(card.open); dock.append(card); card.open = true; }
                    else { chips.append(card); card.open = card.dataset.wasOpen === 'true'; delete card.dataset.wasOpen; }
                }
            }
            for (const card of originalCards) {
                if (docked && !card.hidden && (hiddenCards.get(card) || !Object.hasOwn(card.dataset, 'wasOpen'))) {
                    card.dataset.wasOpen = 'false'; card.open = true;
                }
                hiddenCards.set(card, card.hidden);
            }
            $('pi-task-dock-empty').hidden = originalCards.some(card => !card.hidden);
        };
        new MutationObserver(syncDock).observe(inspector, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(syncDock).observe($('pi-inspector-tasks'), { attributes: true, attributeFilter: ['hidden'] });
        for (const card of originalCards) new MutationObserver(syncDock).observe(card, { attributes: true, attributeFilter: ['hidden'] });
        schedule();
    });
})();
