/* Independent artifact library plus explicitly saved source results. */
(() => {
    const ui = window.PiArtifactsUI, { tr, node, icon, button } = ui;
    const PAGE = 36, HEX = /^[a-f0-9]{64}$/;
    async function api(url, options = {}) {
        const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
        let data; try { data = await response.json(); } catch { throw new Error(tr('无法读取成果服务响应', 'Unable to read the artifacts response')); }
        if (!response.ok) throw new Error(data.error || tr('成果暂时无法读取', 'Artifacts are temporarily unavailable'));
        return data;
    }
    const VIEWS = () => [['saved', tr('已保存', 'Saved'), 'fa-box-archive'], ['favorite', tr('星标', 'Starred'), 'fa-star'], ['all', tr('待保存', 'Unsaved'), 'fa-inbox'], ['trash', tr('回收站', 'Trash'), 'fa-trash-can'], ['hidden', tr('已隐藏', 'Hidden'), 'fa-eye-slash']];
    const ACTIONS = {
        all: [['save', 'favorite', 'collection-add'], []],
        saved: [['favorite', 'collection-add', 'delete'], ['collection-remove', 'project', 'export', 'hide', 'trash']],
        hidden: [['unhide', 'collection-add', 'delete'], ['favorite', 'project', 'export', 'trash']],
        trash: [['restore', 'delete'], []]
    };
    ACTIONS.favorite = ACTIONS.saved;
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-artifacts-label]').forEach(label => { label.textContent = tr('成果中心', 'Artifacts'); });
        const page = document.getElementById('artifacts-tab'); if (!page) return;
        const state = { items: new Map(), savedItems: new Map(), savedSources: new Set(), collections: [], availableProjects: [], selected: new Map(), busy: new Set(), view: 'saved', selecting: false, libraryNext: null, libraryRevision: null, mutating: false, projects: [], type: 'all', project: '', collection: '', query: '', page: 0, active: false, loading: false, epoch: 0, scope: '', next: null, snapshot: null, urls: new Set(), thumbs: new Map(), thumbnailQueue: [], queued: new Set(), storageBytes: 0, limitBytes: 0, trashBytes: 0 };
        const viewer = new window.PiArtifactPreview(api);
        const savedFor = sourceKey => [...state.savedItems.values()].find(i => i.sourceKey === sourceKey && !i.trashedAt);
        const manager = new window.PiArtifactManager(api, state, {
            busy(keys) { state.busy = new Set(keys || []); paintSelection(); },
            navigate(view) { if (viewer.dialog.open) viewer.close(); setView(view); },
            refresh() { void load(true); },
            async changed(result, context) {
                const succeeded = new Set((result.results || []).filter(r => r.ok).map(r => r.key));
                // Decide before reloading: afterwards a purged copy can no longer be matched to the open source.
                const openKeys = viewer.dialog.open ? [viewer.file?.key, viewer.target()?.file.key].filter(Boolean) : [];
                const closesOpen = ['trash', 'purge', 'hide'].includes(context.action) && openKeys.some(k => succeeded.has(k));
                const fromBatch = context.files.length > 0 && context.files.every(f => state.selected.has(f.key));
                for (const key of succeeded) state.selected.delete(key);
                if (fromBatch && !state.selected.size) state.selecting = false;
                const leaves = { save: state.view === 'all', trash: true, purge: true, hide: state.view !== 'hidden', unhide: state.view === 'hidden', restore: state.view === 'trash', favorite: state.view === 'favorite' && context.extra.favorite === false, 'collection-remove': Boolean(state.collection) };
                if (leaves[context.action] && succeeded.size) {
                    let animated = false;
                    for (const wrap of grid.querySelectorAll('.artifacts-card-wrap')) if (wrap.fileKeys.every(k => succeeded.has(k))) { wrap.classList.add('is-leaving'); animated = true; }
                    if (animated && !matchMedia('(prefers-reduced-motion: reduce)').matches) await new Promise(r => setTimeout(r, 190));
                }
                await loadSaved(true); render();
                if (!viewer.dialog.open || !viewer.item) return;
                if (closesOpen) { viewer.close(); return; }
                const current = viewer.item;
                if (current.independent) viewer.sync(state.savedItems.get(current.key) || null);
                else viewer.sync(savedFor(viewer.file?.key) && current.files.length === 1 ? savedFor(viewer.file.key) : current);
            }
        });
        Object.assign(viewer, {
            isSaved: key => Boolean(savedFor(key)), savedItem: key => savedFor(key), collections: () => state.collections,
            manage: async (action, file, item, extra = {}) => {
                if (action === 'location') return manager.location(file);
                if (action === 'favorite') extra = { ...extra, favorite: !(item.independent && item.favorite) };
                return manager.run(action, [file], extra);
            }
        });
        const mediaHeader = document.querySelector('#media-tab .lab-header');
        if (mediaHeader) {
            const back = button(tr('成果库', 'Artifact library'), () => window.PiWorkspaceRoute.navigate('artifacts'), 'lab-secondary');
            back.id = 'lab-open-artifacts'; mediaHeader.append(back);
        }
        // ---------- Header ----------
        const shell = node('div', null, 'artifacts-shell');
        const header = node('header', null, 'artifacts-header'), titleRow = node('div', null, 'artifacts-title');
        const heading = node('h1', tr('成果中心', 'Artifacts'));
        const help = node('details', null, 'artifacts-help'), helpSummary = node('summary');
        helpSummary.append(icon('fa-circle-question', 'fa-regular'), node('span', tr('保存、星标和合集的区别', 'About saving, stars and collections'), 'artifacts-sr'));
        helpSummary.title = tr('保存、星标和合集的区别', 'About saving, stars and collections');
        const helpPanel = node('div', null, 'artifacts-help-panel');
        for (const [glyph, title, text] of [
            ['fa-bookmark', tr('保存', 'Save'), tr('把聊天交付或生成的媒体复制成独立文件。删除聊天后，已保存的成果仍在。', 'Copies a delivery or generated media into an independent file that survives conversation deletion.')],
            ['fa-star', tr('星标', 'Star'), tr('标记常用成果，方便快速找到。取消星标不会删除文件。', 'Marks work you use often. Removing a star never deletes the file.')],
            ['fa-folder', tr('合集', 'Collection'), tr('按主题分组，不是磁盘文件夹。同一成果可以放进多个合集。', 'Groups work by topic, not by disk folder. One artifact can be in several collections.')],
            ['fa-trash-can', tr('删除', 'Delete'), tr('只删除成果库中的副本，来源聊天和原文件不受影响。想留后路时可先移到回收站。', 'Removes only the library copy; source conversations and original files stay. Use trash if you may need it later.')]
        ]) { const row = node('div'); row.append(icon(glyph), node('strong', title), node('p', text)); helpPanel.append(row); }
        help.append(helpSummary, helpPanel);
        titleRow.append(heading, help);
        const subtitle = node('p', null, 'artifacts-subtitle');
        const intro = node('div', null, 'artifacts-intro'); intro.append(titleRow, subtitle);
        const storage = node('div', null, 'artifacts-storage'), storageText = node('span'), meter = node('span', null, 'artifacts-meter'), meterFill = node('span');
        meter.append(meterFill); storage.append(storageText, meter); storage.setAttribute('role', 'img');
        const refresh = button(tr('刷新', 'Refresh'), () => { void load(true); }, 'artifacts-btn is-icon artifacts-refresh', { icon: 'fa-arrows-rotate', iconOnly: true }); refresh.id = 'artifacts-refresh';
        const create = button(tr('去创作', 'Create'), () => window.PiWorkspaceRoute.navigate('media'), 'artifacts-btn artifacts-create', { icon: 'fa-wand-magic-sparkles' });
        const headerActions = node('div', null, 'artifacts-header-actions'); headerActions.append(storage, refresh, create);
        header.append(intro, headerActions);
        // ---------- Views ----------
        const views = node('nav', null, 'artifacts-views'); views.setAttribute('aria-label', tr('成果视图', 'Artifact views'));
        const primaryViews = node('div', null, 'artifacts-views-main'), secondaryViews = node('div', null, 'artifacts-views-aside');
        for (const [id, label, glyph] of VIEWS()) {
            const b = button(label, () => setView(id), '', { icon: glyph }); b.dataset.view = id;
            b.append(node('span', '', 'artifacts-count'));
            (['trash', 'hidden'].includes(id) ? secondaryViews : primaryViews).append(b);
        }
        views.append(primaryViews, secondaryViews);
        // ---------- Toolbar ----------
        const toolbar = node('div', null, 'artifacts-toolbar');
        const searchLabel = node('label', null, 'artifacts-search');
        const search = node('input'); search.id = 'artifacts-search'; search.type = 'search'; search.maxLength = 200; search.autocomplete = 'off';
        search.placeholder = tr('搜索名称、文件或模型', 'Search names, files or models'); search.setAttribute('aria-label', tr('搜索成果', 'Search artifacts'));
        const clearSearch = button(tr('清除搜索', 'Clear search'), () => { search.value = ''; state.query = ''; resetPage(); render(); search.focus(); }, 'artifacts-search-clear', { icon: 'fa-xmark', iconOnly: true });
        const shortcut = node('kbd', '/', 'artifacts-kbd');
        searchLabel.append(icon('fa-magnifying-glass'), search, clearSearch, shortcut);
        const types = node('div', null, 'artifacts-types'); types.setAttribute('role', 'group'); types.setAttribute('aria-label', tr('成果类型', 'Artifact type'));
        for (const kind of ['all', ...ui.kinds]) { const b = button(kind === 'all' ? tr('全部', 'All') : ui.kindLabel(kind), () => { state.type = kind; resetPage(); render(); }); b.dataset.kind = kind; types.append(b); }
        const pill = (id, glyph, label) => {
            const wrap = node('label', null, 'artifacts-pill'), text = node('span', null, 'artifacts-pill-text'), select = node('select'); select.id = id; select.setAttribute('aria-label', label);
            wrap.append(icon(glyph, 'fa-regular'), text, icon('fa-chevron-down'), select); wrap.text = text; wrap.select = select; return wrap;
        };
        const projectPill = pill('artifacts-project', 'fa-folder-open', tr('项目标签', 'Project label')), projects = projectPill.select;
        const collectionPill = pill('artifacts-collection', 'fa-bookmark', tr('合集', 'Collection')), collectionFilter = collectionPill.select;
        const filters = node('div', null, 'artifacts-filters'); filters.append(types, node('span', null, 'artifacts-divider'), projectPill, collectionPill);
        const selectMode = button(tr('选择', 'Select'), () => { setSelecting(!state.selecting); }, 'artifacts-btn artifacts-select-toggle', { icon: 'fa-square-check', iconStyle: 'fa-regular' }); selectMode.id = 'artifacts-select';
        toolbar.append(searchLabel, filters, selectMode);
        // ---------- Context (active filters, scope, notices) ----------
        const context = node('div', null, 'artifacts-context');
        const contextChips = node('div', null, 'artifacts-context-chips'), resultCount = node('span', null, 'artifacts-result-count');
        context.append(contextChips, resultCount);
        const notice = node('div', null, 'artifacts-notice'), noticeText = node('span'); noticeText.setAttribute('role', 'status');
        const noticeAction = button('', null, 'artifacts-link');
        const dismiss = button(tr('关闭提示', 'Dismiss message'), () => { notice.hidden = true; }, 'artifacts-notice-close', { icon: 'fa-xmark', iconOnly: true });
        notice.append(icon('fa-circle-info'), noticeText, noticeAction, dismiss); notice.hidden = true;
        // ---------- Grid, empty, footer ----------
        const grid = node('div', null, 'artifacts-grid'); grid.id = 'artifacts-grid';
        const empty = node('div', null, 'artifacts-empty'), emptyIcon = node('span', null, 'artifacts-empty-icon'), emptyTitle = node('h2'), emptyText = node('p'), emptyActions = node('div', null, 'artifacts-empty-actions');
        empty.append(emptyIcon, emptyTitle, emptyText, emptyActions);
        const footer = node('div', null, 'artifacts-footer');
        const previous = button(tr('上一页', 'Previous page'), () => turn(-1), 'artifacts-btn is-icon', { icon: 'fa-chevron-left', iconOnly: true });
        const next = button(tr('下一页', 'Next page'), () => turn(1), 'artifacts-btn is-icon', { icon: 'fa-chevron-right', iconOnly: true });
        const pageCount = node('span', null, 'artifacts-page-count'); const pager = node('div', null, 'artifacts-pager'); pager.append(previous, pageCount, next);
        const more = button(tr('继续发现来源', 'Discover more sources'), () => { void load(false); }, 'artifacts-btn', { icon: 'fa-arrow-down' }); more.id = 'artifacts-more';
        footer.append(pager, more);
        // ---------- Selection bar ----------
        const batchbar = node('div', null, 'artifacts-batchbar'); batchbar.id = 'artifacts-batchbar'; batchbar.setAttribute('role', 'toolbar'); batchbar.setAttribute('aria-label', tr('所选文件操作', 'Selected file actions'));
        const exitSelect = button(tr('退出选择', 'Exit selection'), () => setSelecting(false), 'artifacts-bar-close', { icon: 'fa-xmark', iconOnly: true });
        const selectedCount = node('strong', null, 'artifacts-selected-count'); selectedCount.setAttribute('aria-live', 'polite');
        const selectPage = button(tr('全选本页', 'Select page'), () => togglePage(), 'artifacts-link');
        const batchInfo = node('div', null, 'artifacts-bar-info'); batchInfo.append(exitSelect, selectedCount, selectPage);
        const batchActions = node('div', null, 'artifacts-bar-actions');
        const ACTION_UI = () => ({
            save: [tr('保存', 'Save'), 'fa-bookmark', 'is-primary'], favorite: [tr('加星标', 'Star'), 'fa-star'], 'collection-add': [tr('加入合集', 'Add to collection'), 'fa-folder-plus'],
            'collection-remove': [tr('移出此合集', 'Remove from collection'), 'fa-folder-minus'], project: [tr('设置项目标签…', 'Set project label…'), 'fa-tag'], export: [tr('导出到服务器…', 'Export to server…'), 'fa-server'],
            hide: [tr('隐藏', 'Hide'), 'fa-eye-slash'], unhide: [tr('取消隐藏', 'Unhide'), 'fa-eye', 'is-primary'], trash: [tr('移到回收站', 'Move to trash'), 'fa-trash-arrow-up'], restore: [tr('恢复', 'Restore'), 'fa-rotate-left', 'is-primary'],
            delete: [tr('删除', 'Delete'), 'fa-trash-can', 'is-danger']
        });
        const batchButtons = new Map();
        for (const [action, [label, glyph, tone]] of Object.entries(ACTION_UI())) {
            const b = button(label, () => { void runBatch(action); }, 'artifacts-bar-btn ' + (tone || ''), { icon: glyph }); b.dataset.action = action; batchButtons.set(action, b);
        }
        const moreButton = button(tr('更多操作', 'More actions'), null, 'artifacts-bar-btn', { icon: 'fa-ellipsis' });
        const batchMore = ui.menu(moreButton, () => (ACTIONS[state.view] || ACTIONS.saved)[1].map(action => ({ label: ACTION_UI()[action][0], icon: ACTION_UI()[action][1], action, hidden: action === 'collection-remove' && !state.collection, run: () => { void runBatch(action); } })), { up: true });
        batchMore.classList.add('artifacts-batch-more');
        const working = node('span', null, 'artifacts-bar-working'); working.append(node('span', null, 'artifacts-spinner'), node('span', tr('正在处理…', 'Working…')));
        batchActions.append(...batchButtons.values(), batchMore);
        const batchHint = node('span', tr('点按文件进行选择', 'Tap files to select them'), 'artifacts-bar-hint');
        batchbar.append(batchInfo, batchHint, batchActions, working);
        shell.append(header, views, toolbar, context, notice, grid, empty, footer);
        page.append(shell, batchbar);
        // ---------- Thumbnails ----------
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                const key = entry.target.dataset.key; observer.unobserve(entry.target);
                if (!state.queued.has(key)) { state.queued.add(key); state.thumbnailQueue.push(key); }
            }
            void thumbnails();
        }, { root: page, rootMargin: '120px' });
        function disposeThumbnails() {
            observer.disconnect(); state.thumbnailController?.abort(); state.thumbnailQueue = []; state.queued.clear();
            for (const url of state.urls) URL.revokeObjectURL(url); state.urls.clear(); state.thumbs.clear();
        }
        async function thumbnails() {
            if (state.thumbnailBusy || !state.active || state.loading || viewer.dialog.open) return;
            state.thumbnailBusy = true; const epoch = state.epoch;
            try {
                while (state.thumbnailQueue.length && state.active && epoch === state.epoch && !viewer.dialog.open) {
                    const key = state.thumbnailQueue.shift(); if (state.thumbs.has(key)) continue;
                    state.thumbnailController = new AbortController();
                    try {
                        const data = await api(`/api/pi/artifacts/${key}/cover`, { signal: state.thumbnailController.signal });
                        if (epoch !== state.epoch || !state.active) return;
                        if (data.kind !== 'image' || !/^image\/(png|jpeg|webp|gif)$/.test(data.mime) || typeof data.base64 !== 'string' || data.base64.length > 3 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.base64)) continue;
                        const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(data.base64), c => c.charCodeAt(0))], { type: data.mime }));
                        state.urls.add(url); state.thumbs.set(key, url);
                        while (state.thumbs.size > 36) { const oldest = state.thumbs.keys().next().value, oldUrl = state.thumbs.get(oldest); state.thumbs.delete(oldest); state.queued.delete(oldest); state.urls.delete(oldUrl); URL.revokeObjectURL(oldUrl); }
                        const cover = grid.querySelector(`.artifacts-card[data-key="${key}"] .artifacts-cover`); if (cover) applyThumb(cover, url);
                    } catch { /* A cover is optional. A real open surfaces source errors. */ }
                }
            } finally { state.thumbnailBusy = false; if (state.active && epoch !== state.epoch && state.thumbnailQueue.length) void thumbnails(); }
        }
        function applyThumb(cover, url) {
            if (cover.querySelector('img')) return;
            const image = node('img'); image.alt = ''; image.decoding = 'async'; image.src = url;
            image.addEventListener('load', () => cover.classList.add('has-image'), { once: true }); cover.prepend(image);
            if (image.complete && image.naturalWidth) cover.classList.add('has-image');
        }
        // ---------- Data views ----------
        function projectOptions() {
            projects.replaceChildren();
            const option = (value, label, title) => { const o = node('option', label); o.value = value; if (title) o.title = title; projects.append(o); };
            option('', tr('全部项目', 'All projects')); option('unknown', tr('无项目标签', 'No project label'));
            for (const item of state.projects) option(item.key, item.name, item.cwd);
            if (state.cwd) { const p = state.projects.find(p => p.cwd === state.cwd); if (p) state.project = p.key; }
            if (state.project !== 'unknown' && ![...projects.options].some(o => o.value === state.project)) state.project = '';
            projects.value = state.project;
        }
        const library = () => [...state.savedItems.values()];
        function unsavedItems() {
            const represented = state.savedSources;
            return [...state.items.values()].map(item => ({ ...item, files: item.files.filter(f => !represented.has(f.key)) })).filter(i => i.files.length);
        }
        function inView(item, view) {
            if (view === 'trash') return Boolean(item.trashedAt);
            if (view === 'hidden') return !item.trashedAt && Boolean(item.hiddenAt);
            if (view === 'favorite') return !item.trashedAt && !item.hiddenAt && item.favorite;
            return !item.trashedAt && !item.hiddenAt;
        }
        const filtered = () => Boolean(state.query.trim() || state.type !== 'all' || state.project || state.collection || state.sessionId);
        function visibleItems() {
            const all = state.view === 'all' ? unsavedItems() : library().filter(i => inView(i, state.view));
            const query = state.query.trim().toLocaleLowerCase();
            return all.filter(item => (!state.collection || item.collections?.includes(state.collection))
                && (state.type === 'all' || item.types.includes(state.type))
                && (!state.project || (state.project === 'unknown' ? !item.project : item.project?.key === state.project))
                && (!state.sessionId || item.origin?.sessionId === state.sessionId)
                && (!query || [item.title, item.project?.name || '', item.model || '', ...item.files.flatMap(f => [f.name, f.originalName || ''])].join(' ').toLocaleLowerCase().includes(query)))
                .sort((a, b) => String(b.savedAt || b.createdAt || '').localeCompare(String(a.savedAt || a.createdAt || '')));
        }
        function counts() {
            const lib = library(), more = state.libraryNext != null ? '+' : '';
            const unsaved = unsavedItems().length;
            return { saved: lib.filter(i => inView(i, 'saved')).length + more, favorite: lib.filter(i => inView(i, 'favorite')).length + more, all: unsaved ? unsaved + (state.next != null ? '+' : '') : '',
                trash: lib.filter(i => i.trashedAt).length || '', hidden: lib.filter(i => inView(i, 'hidden')).length || '' };
        }
        const titleOf = item => { const file = item.files[0], kind = item.types[0] || 'other'; return item.source === 'media' && item.title === file.name ? (item.model || ui.kindLabel(kind)) : item.title || file.name; };
        const fileOf = (item, f) => ({ key: f.key, name: f.name, kind: f.kind || item.types?.[0] || 'other', revision: item.revision, trashed: Boolean(item.trashedAt), deletionPending: Boolean(item.deletionPending) });
        const pageItems = () => visibleItems().slice(state.page * PAGE, state.page * PAGE + PAGE);
        // ---------- State transitions ----------
        function resetPage() { state.page = 0; state.selected.clear(); state.anchor = null; }
        function setView(id) {
            if (state.mutating) return;
            notice.hidden = true; state.view = id; if (id === 'all' || id === 'trash') state.collection = '';
            resetPage(); setSelecting(false, true); render(); page.scrollTo({ top: 0 });
        }
        function setSelecting(on, silent) {
            if (state.mutating && !on) return;
            state.selecting = on; if (!on) { state.selected.clear(); state.anchor = null; }
            ui.closeMenus(); if (!silent) { paintSelection(); }
        }
        function turn(delta) { if (state.mutating) return; state.page += delta; state.selected.clear(); render(); page.scrollTo({ top: 0, behavior: 'smooth' }); }
        function select(item, on = null) {
            const files = item.files.map(f => fileOf(item, f)), all = files.every(f => state.selected.has(f.key));
            const target = on ?? !all;
            for (const f of files) { if (!target) state.selected.delete(f.key); else if (state.selected.size < 50) state.selected.set(f.key, f); }
            if (target && files.some(f => !state.selected.has(f.key))) ui.toast({ tone: 'info', message: tr('一次最多选择 50 个文件。', 'You can select up to 50 files at a time.') });
        }
        function togglePage() {
            // The outstanding batch owns the selection until its results are applied.
            if (state.mutating) return;
            const items = pageItems(), files = items.flatMap(i => i.files);
            const all = files.length && files.every(f => state.selected.has(f.key));
            if (all) files.forEach(f => state.selected.delete(f.key)); else for (const item of items) select(item, true);
            paintSelection();
        }
        function runBatch(action) {
            const files = [...state.selected.values()]; if (!files.length || state.mutating) return;
            const extra = action === 'favorite' ? { favorite: !allStarred() } : action === 'collection-remove' ? { collectionId: state.collection } : {};
            void manager.run(action, files, extra);
        }
        function allStarred() { return state.selected.size > 0 && [...state.selected.keys()].every(key => state.savedItems.get(key)?.favorite); }
        // ---------- Rendering ----------
        function render() {
            const focused = document.activeElement, focusKey = focused?.closest?.('.artifacts-card-wrap')?.dataset.key, focusRole = focused?.dataset?.role;
            observer.disconnect(); state.thumbnailQueue = []; state.queued.clear();
            const items = visibleItems();
            state.page = Math.max(0, Math.min(state.page, Math.ceil(items.length / PAGE) - 1));
            paintChrome(items); paintGrid(items); paintSelection();
            if (focusKey && HEX.test(focusKey)) grid.querySelector(`.artifacts-card-wrap[data-key="${focusKey}"] [data-role="${focusRole || 'open'}"]`)?.focus({ preventScroll: true });
        }
        function paintChrome(items) {
            const c = counts();
            views.querySelectorAll('[data-view]').forEach(b => {
                const current = b.dataset.view === state.view;
                if (current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
                b.disabled = state.mutating; const count = b.querySelector('.artifacts-count'); count.textContent = c[b.dataset.view] || '';
                b.classList.toggle('has-pending', b.dataset.view === 'all' && Boolean(c.all));
            });
            const used = state.storageBytes, limit = state.limitBytes;
            storage.hidden = !limit; storageText.textContent = tr(`已用 ${ui.bytes(used)}`, `${ui.bytes(used)} used`);
            meterFill.style.setProperty('width', `${Math.min(100, Math.max(used ? 1.5 : 0, used / (limit || 1) * 100)).toFixed(1)}%`);
            storage.setAttribute('aria-label', tr(`成果库已用 ${ui.bytes(used)}，上限 ${ui.bytes(limit)}`, `Library uses ${ui.bytes(used)} of ${ui.bytes(limit)}`)); storage.title = storage.getAttribute('aria-label');
            subtitle.textContent = state.view === 'all' ? tr('来自聊天交付和媒体生成的结果。保存后，删除聊天也不会丢失。', 'Results from conversations and media generation. Save them to keep them after the conversation is gone.')
                : state.view === 'trash' ? (state.trashBytes ? tr(`回收站中的文件仍占用 ${ui.bytes(state.trashBytes)}，可以恢复或永久删除。`, `Trash still uses ${ui.bytes(state.trashBytes)}. Restore or delete permanently.`) : tr('移到回收站的成果可以恢复，也可以永久删除。', 'Trashed artifacts can be restored or deleted permanently.'))
                    : state.view === 'hidden' ? tr('隐藏只影响展示，文件仍然保留。', 'Hidden artifacts are kept, just out of sight.')
                        : state.view === 'favorite' ? tr('常用的成果，一处找到。', 'The work you reach for most.')
                            : tr('保存有价值的结果，在这里查找、整理和使用。', 'Keep useful results. Find, organize and use them here.');
            types.querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.kind === state.type)); b.disabled = state.mutating; });
            search.disabled = projects.disabled = collectionFilter.disabled = state.mutating; refresh.disabled = state.loading || state.mutating;
            refresh.classList.toggle('is-spinning', state.loading);
            searchLabel.classList.toggle('has-value', Boolean(search.value));
            projectPill.text.textContent = state.project === 'unknown' ? tr('无项目标签', 'No project label') : state.projects.find(p => p.key === state.project)?.name || tr('项目', 'Project');
            projectPill.classList.toggle('is-active', Boolean(state.project));
            collectionFilter.replaceChildren();
            for (const c2 of [{ id: '', name: tr('全部合集', 'All collections') }, ...state.collections, { id: '__new__', name: tr('＋ 新建合集…', '+ New collection…') }]) { const o = node('option', c2.name); o.value = c2.id; collectionFilter.append(o); }
            collectionFilter.value = state.collection || '';
            const collection = state.collections.find(c2 => c2.id === state.collection);
            collectionPill.text.textContent = collection?.name || tr('合集', 'Collections'); collectionPill.classList.toggle('is-active', Boolean(collection));
            collectionPill.hidden = state.view === 'all' || state.view === 'trash';
            selectMode.disabled = state.mutating || (!items.length && !state.selecting);
            // Active filters as removable chips; the collection chip also carries its management.
            contextChips.replaceChildren();
            const chip = (glyph, label, clear, extraNode) => { const c3 = node('span', null, 'artifacts-chip is-filter'); c3.append(icon(glyph), node('span', label)); if (extraNode) c3.append(extraNode); c3.append(button(tr(`清除「${label}」`, `Clear “${label}”`), clear, 'artifacts-chip-remove', { icon: 'fa-xmark', iconOnly: true })); contextChips.append(c3); };
            if (collection) {
                const manage = button(tr('管理合集', 'Manage collection'), null, 'artifacts-chip-menu', { icon: 'fa-ellipsis', iconOnly: true });
                const menu = ui.menu(manage, () => [
                    { label: tr('重命名合集…', 'Rename collection…'), icon: 'fa-pen', run: () => { void manager.run('collection-rename', [], { collectionId: collection.id, name: collection.name }); } },
                    { label: tr('删除合集…', 'Delete collection…'), icon: 'fa-folder-minus', danger: true, run: () => { void manager.run('collection-delete', [], { collectionId: collection.id }); } }
                ], { start: true });
                chip('fa-bookmark', collection.name, () => { state.collection = ''; resetPage(); render(); }, menu);
            }
            if (state.project) chip('fa-folder-open', projectPill.text.textContent, () => { projects.value = ''; projects.dispatchEvent(new Event('change')); });
            if (state.sessionId) chip('fa-comments', tr('当前会话', 'This conversation'), () => window.PiWorkspaceRoute.navigate('artifacts'));
            if (state.query.trim()) chip('fa-magnifying-glass', `“${state.query.trim()}”`, () => { search.value = ''; state.query = ''; resetPage(); render(); });
            if (state.type !== 'all') chip(ui.kindIcon(state.type), ui.kindLabel(state.type), () => { state.type = 'all'; resetPage(); render(); });
            if (contextChips.children.length > 1) contextChips.append(button(tr('全部清除', 'Clear all'), clearFilters, 'artifacts-link'));
            resultCount.textContent = filtered() ? tr(`${items.length} 项结果`, `${items.length} results`) : '';
            context.hidden = !contextChips.children.length;
            // Empty and loading states.
            const loadingFirst = state.loading && !items.length;
            empty.hidden = items.length > 0 || loadingFirst; emptyActions.replaceChildren();
            const emptyState = (glyph, title, text, ...actions) => { emptyIcon.replaceChildren(icon(glyph, glyph === 'fa-star' ? 'fa-regular' : 'fa-solid')); emptyTitle.textContent = title; emptyText.textContent = text; emptyActions.append(...actions); };
            const c4 = counts();
            if (state.failed && !items.length) emptyState('fa-triangle-exclamation', tr('成果暂时无法读取', 'Artifacts are temporarily unavailable'), tr('来源没有被修改。请稍后重试，或回到来源会话查看。', 'Sources were not changed. Try again later or open the source conversation.'), button(tr('重试', 'Try again'), () => { void load(true); }, 'artifacts-btn is-primary', { icon: 'fa-arrows-rotate' }));
            else if (filtered()) emptyState('fa-magnifying-glass', tr('没有匹配的成果', 'No matching artifacts'), state.view === 'all' && state.next != null ? tr('换个关键词或清除筛选；也可以继续发现更多来源。', 'Try other words or clear filters, or discover more sources.') : tr('换个关键词，或清除筛选条件。', 'Try other words or clear the filters.'), button(tr('清除筛选', 'Clear filters'), clearFilters, 'artifacts-btn'));
            else if (state.view === 'saved') emptyState('fa-box-archive', tr('把值得留下的结果存在这里', 'Keep your best results here'), tr('聊天中交付的文件和生成的媒体会先出现在「待保存」。保存后，删除聊天也不会丢失。', 'Files delivered in conversations and generated media appear in Unsaved first. Once saved, they outlive the conversation.'),
                ...(c4.all ? [button(tr(`查看待保存（${c4.all}）`, `Review unsaved (${c4.all})`), () => setView('all'), 'artifacts-btn is-primary', { icon: 'fa-inbox' })] : []), button(tr('去创作', 'Create something'), () => window.PiWorkspaceRoute.navigate('media'), 'artifacts-btn', { icon: 'fa-wand-magic-sparkles' }));
            else if (state.view === 'favorite') emptyState('fa-star', tr('还没有星标成果', 'No starred artifacts yet'), tr('在成果上点星标，常用的内容就会出现在这里。', 'Star an artifact and it will show up here for quick access.'));
            else if (state.view === 'all') emptyState('fa-inbox', tr('没有待保存的结果', 'Nothing waiting to be saved'), tr('让 Agent 交付报告、网页或文件，或在创作工具中生成媒体，它们会出现在这里。上传的参考素材不会自动出现。', 'Ask your Agent to deliver a report, web page or file, or generate media; they will appear here. Uploaded references are not included.'), button(tr('去创作', 'Create something'), () => window.PiWorkspaceRoute.navigate('media'), 'artifacts-btn', { icon: 'fa-wand-magic-sparkles' }));
            else if (state.view === 'trash') emptyState('fa-trash-can', tr('回收站是空的', 'Trash is empty'), tr('移到回收站的成果可以恢复，也可以永久删除。', 'Trashed artifacts can be restored or deleted permanently.'));
            else emptyState('fa-eye-slash', tr('没有隐藏的成果', 'No hidden artifacts'), tr('隐藏只影响展示，不会删除文件。', 'Hiding changes visibility without deleting files.'));
            const pages = Math.ceil(items.length / PAGE);
            pager.hidden = pages < 2; previous.disabled = state.mutating || state.page === 0; next.disabled = state.mutating || state.page + 1 >= pages;
            // Filter changes clear the selection, so they wait for an outstanding write.
            contextChips.querySelectorAll('button').forEach(b => { b.disabled = state.mutating; }); clearSearch.disabled = state.mutating;
            pageCount.textContent = pages > 1 ? `${state.page + 1} / ${pages}` : '';
            ui.relabel(more, state.view !== 'all' || state.libraryNext != null && state.next == null ? tr('加载更多成果', 'Load more artifacts') : tr('继续发现来源', 'Discover more sources'));
            more.hidden = state.view !== 'all' ? state.libraryNext == null : state.next == null && state.libraryNext == null; more.disabled = state.loading || state.mutating;
            footer.hidden = pager.hidden && more.hidden;
            grid.setAttribute('aria-busy', String(state.loading));
        }
        function paintGrid(items) {
            grid.replaceChildren();
            if (state.loading && !items.length) {
                for (let i = 0; i < 8; i++) { const s = node('div', null, 'artifacts-card-wrap is-skeleton'); s.setAttribute('aria-hidden', 'true'); s.append(node('div', null, 'artifacts-cover'), node('div', null, 'artifacts-skeleton-line'), node('div', null, 'artifacts-skeleton-line is-short')); grid.append(s); }
                return;
            }
            for (const item of items.slice(state.page * PAGE, state.page * PAGE + PAGE)) grid.append(card(item, items));
        }
        function cover(item, kind) {
            const file = item.files[0], ext = ui.extension(file.name);
            const box = node('div', null, `artifacts-cover artifacts-cover-${kind}` + (item.files.length > 1 ? ' is-stack' : ''));
            const art = node('div', null, 'artifacts-art');
            if (kind === 'document' || kind === 'other') {
                const sheet = node('span', null, 'artifacts-sheet'); sheet.append(node('i'), node('i'), node('i'), node('i'), node('i'), node('b', ext || (kind === 'other' ? 'FILE' : 'DOC'))); art.append(sheet);
            } else if (kind === 'web') {
                const win = node('span', null, 'artifacts-window'); win.append(node('span', null, 'artifacts-window-bar'), node('i'), node('i'), node('i')); art.append(win);
            } else if (kind === 'audio') {
                const wave = node('span', null, 'artifacts-wave'); const seed = parseInt(file.key.slice(-6), 16) || 7;
                for (let i = 0; i < 18; i++) { const bar = node('i'); bar.style.setProperty('--h', `${22 + ((seed >> (i % 20)) + i * 37) % 70}%`); wave.append(bar); }
                art.append(wave);
            } else if (kind === 'video') { const play = node('span', null, 'artifacts-play'); play.append(icon('fa-play')); art.append(play); }
            else art.append(icon(ui.kindIcon(kind)));
            box.append(art);
            if (ext && kind !== 'document' && kind !== 'other') box.append(node('span', ext, 'artifacts-ext'));
            if (item.files.length > 1) { const stack = node('span', null, 'artifacts-stack'); stack.append(icon('fa-layer-group'), node('span', tr(`${item.files.length} 个文件`, `${item.files.length} files`))); box.append(stack); }
            if (item.deletionPending) { const warn = node('span', null, 'artifacts-flag is-danger'); warn.append(icon('fa-triangle-exclamation'), node('span', tr('删除待核对', 'Deletion needs review'))); box.append(warn); }
            if (state.thumbs.has(file.key)) applyThumb(box, state.thumbs.get(file.key));
            return box;
        }
        function card(item, items) {
            const file = item.files[0], kind = item.types[0] || 'other', title = titleOf(item);
            const wrap = node('div', null, 'artifacts-card-wrap'); wrap.dataset.key = file.key; wrap.fileKeys = item.files.map(f => f.key); wrap.item = item;
            const main = button(null, e => onCard(e, item, items, title), 'artifacts-card'); main.dataset.key = file.key; main.dataset.role = 'open';
            const content = node('div', null, 'artifacts-card-content'), heading2 = node('h2', title); heading2.title = title;
            const meta = node('p', null, 'artifacts-card-meta');
            const where = item.project?.name || (item.source === 'media' && item.model && title !== item.model ? item.model : '');
            if (where) meta.append(node('span', where));
            const when = node('time', ui.day(state.view === 'trash' ? item.trashedAt : item.savedAt || item.createdAt) || tr('历史记录', 'Historical')); if (item.createdAt) when.dateTime = item.savedAt || item.createdAt; meta.append(when);
            content.append(heading2, meta); main.append(cover(item, kind), content); main.setAttribute('aria-label', title);
            wrap.append(main);
            // Corner check: always present in selection mode; on desktop it also starts selection.
            const check = button(tr(`选择「${title}」`, `Select “${title}”`), e => { e.stopPropagation(); if (state.mutating) return; if (!state.selecting) setSelecting(true, true); if (e.shiftKey && state.anchor) range(item, items); else select(item); state.anchor = file.key; paintSelection(); }, 'artifacts-check', { icon: 'fa-check', iconOnly: true });
            check.dataset.role = 'check'; check.setAttribute('role', 'checkbox'); wrap.append(check);
            if (state.view !== 'trash' && item.independent) {
                const star = button(item.favorite ? tr('取消星标', 'Unstar') : tr('加星标', 'Star'), e => { e.stopPropagation(); void manager.run('favorite', [fileOf(item, file)], { favorite: !item.favorite }); }, 'artifacts-star' + (item.favorite ? ' is-on' : ''), { icon: 'fa-star', iconStyle: item.favorite ? 'fa-solid' : 'fa-regular', iconOnly: true });
                star.dataset.role = 'star'; star.setAttribute('aria-pressed', String(Boolean(item.favorite))); if (item.files.length === 1) wrap.append(star);
            }
            const quick = state.view === 'all' ? [tr('保存', 'Save'), 'fa-bookmark', 'save', item.files.length > 1 ? tr(`保存全部 ${item.files.length} 个文件`, `Save all ${item.files.length} files`) : tr(`保存「${title}」`, `Save “${title}”`)]
                : state.view === 'trash' && !item.deletionPending ? [tr('恢复', 'Restore'), 'fa-rotate-left', 'restore', tr(`恢复「${title}」`, `Restore “${title}”`)]
                    : state.view === 'hidden' ? [tr('取消隐藏', 'Unhide'), 'fa-eye', 'unhide', tr(`取消隐藏「${title}」`, `Unhide “${title}”`)] : null;
            if (quick) {
                const b = button(quick[0], e => { e.stopPropagation(); void manager.run(quick[2], item.files.map(f => fileOf(item, f))); }, 'artifacts-quick', { icon: quick[1] });
                b.setAttribute('aria-label', quick[3]); b.title = quick[3]; b.dataset.role = 'quick'; b.dataset.action = quick[2]; wrap.append(b);
            }
            if (item.files.length > 1) {
                const chips = node('div', null, 'artifacts-file-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', tr('选择组内文件', 'Choose files in this group'));
                for (const f of item.files) {
                    const c = button(f.name, e => { e.stopPropagation(); if (state.selected.has(f.key)) state.selected.delete(f.key); else if (state.selected.size < 50) state.selected.set(f.key, fileOf(item, f)); paintSelection(); }, 'artifacts-file-chip', { icon: 'fa-check' });
                    c.dataset.selectionKey = f.key; c.setAttribute('role', 'checkbox'); c.title = f.name; chips.append(c);
                }
                wrap.append(chips);
            }
            const busy = node('span', null, 'artifacts-busy'); busy.append(node('span', null, 'artifacts-spinner')); wrap.append(busy);
            longPress(main, item);
            if (kind === 'image' && !state.thumbs.has(file.key)) observer.observe(main);
            return wrap;
        }
        function range(item, items) {
            const keys = items.flatMap(i => i.files.map(f => fileOf(i, f))), start = keys.findIndex(f => f.key === state.anchor), end = keys.findIndex(f => f.key === item.files[0].key);
            if (start >= 0 && end >= 0) for (const f of keys.slice(Math.min(start, end), Math.max(start, end) + 1)) { if (state.selected.size >= 50) break; state.selected.set(f.key, f); }
        }
        function onCard(e, item, items, title) {
            if (state.mutating) return;
            if (main_suppressed) { main_suppressed = false; return; }
            if (state.selecting || e.metaKey || e.ctrlKey) {
                if (!state.selecting) setSelecting(true, true);
                if (e.shiftKey && state.anchor) range(item, items); else select(item);
                state.anchor = item.files[0].key; paintSelection(); return;
            }
            state.thumbnailController?.abort(); state.thumbnailQueue = []; viewer.open({ ...item, title });
        }
        let main_suppressed = false;
        // Touch: press and hold a card to start selecting, like a photo library.
        function longPress(target, item) {
            let timer = null, origin = null;
            const cancel = () => { clearTimeout(timer); timer = null; };
            target.addEventListener('pointerdown', e => {
                main_suppressed = false;
                if (e.pointerType === 'mouse' || state.mutating) return; origin = [e.clientX, e.clientY];
                timer = setTimeout(() => { timer = null; main_suppressed = true; if (!state.selecting) setSelecting(true, true); select(item, true); state.anchor = item.files[0].key; paintSelection(); navigator.vibrate?.(12); }, 480);
            });
            target.addEventListener('pointermove', e => { if (timer && origin && Math.hypot(e.clientX - origin[0], e.clientY - origin[1]) > 8) cancel(); });
            for (const type of ['pointerup', 'pointercancel', 'pointerleave']) target.addEventListener(type, cancel);
            target.addEventListener('contextmenu', e => { if (e.pointerType !== 'mouse' && main_suppressed) e.preventDefault(); });
        }
        // Selection paint is incremental so hover, focus and thumbnails survive.
        function paintSelection() {
            page.classList.toggle('is-selecting', state.selecting);
            for (const wrap of grid.querySelectorAll('.artifacts-card-wrap:not(.is-skeleton)')) {
                const keys = wrap.fileKeys, picked = keys.filter(k => state.selected.has(k)).length;
                wrap.classList.toggle('is-selected', picked > 0); wrap.classList.toggle('is-partial', picked > 0 && picked < keys.length);
                wrap.classList.toggle('is-busy', keys.some(k => state.busy.has(k)));
                const check = wrap.querySelector('.artifacts-check'); check.setAttribute('aria-checked', picked === keys.length ? 'true' : picked ? 'mixed' : 'false');
                wrap.querySelectorAll('.artifacts-file-chip').forEach(c => c.setAttribute('aria-checked', String(state.selected.has(c.dataset.selectionKey))));
                const main = wrap.querySelector('.artifacts-card'); if (state.selecting) main.setAttribute('aria-pressed', String(picked === keys.length)); else main.removeAttribute('aria-pressed');
                wrap.querySelectorAll('button').forEach(b => { if (b !== main) b.disabled = state.mutating; });
            }
            batchbar.hidden = !state.selecting;
            const n = state.selected.size;
            selectedCount.textContent = n ? tr(`已选 ${n} 项`, `${n} selected`) : tr('选择文件', 'Select files');
            const files = pageItems().flatMap(i => i.files);
            ui.relabel(selectPage, files.length && files.every(f => state.selected.has(f.key)) ? tr('取消全选', 'Deselect all') : tr('全选本页', 'Select page'));
            selectPage.hidden = !files.length; selectPage.disabled = state.mutating;
            const [primary, secondary] = ACTIONS[state.view] || ACTIONS.saved;
            for (const [action, b] of batchButtons) {
                b.hidden = !primary.includes(action) || !n; b.disabled = state.mutating;
                if (action === 'favorite') ui.relabel(b, allStarred() ? tr('取消星标', 'Unstar') : state.view === 'all' ? tr('保存并加星标', 'Save & star') : tr('加星标', 'Star'));
                if (action === 'delete') ui.relabel(b, state.view === 'trash' ? tr('永久删除', 'Delete permanently') : tr('删除', 'Delete'));
            }
            batchMore.hidden = !n || !secondary.some(a => a !== 'collection-remove' || state.collection);
            moreButton.disabled = state.mutating;
            batchHint.hidden = n > 0; working.hidden = !state.mutating; batchActions.hidden = state.mutating;
            selectMode.setAttribute('aria-pressed', String(state.selecting)); ui.relabel(selectMode, state.selecting ? tr('完成', 'Done') : tr('选择', 'Select'));
            selectMode.classList.toggle('is-on', state.selecting);
            batchbar.classList.toggle('is-working', state.mutating);
        }
        function clearFilters() {
            state.collection = ''; state.project = ''; state.type = 'all'; state.query = ''; search.value = ''; resetPage();
            if (state.cwd || state.sessionId) window.PiWorkspaceRoute.navigate('artifacts'); else render();
        }
        // ---------- Loading ----------
        async function loadSaved(reset) {
            const epoch = state.epoch;
            const params = new URLSearchParams(); if (!reset && state.libraryNext != null) { params.set('offset', state.libraryNext); params.set('revision', state.libraryRevision); }
            const data = await api('/api/pi/artifacts/library?' + params, { signal: state.controller?.signal });
            if (epoch !== state.epoch || !state.active) return;
            if (reset) state.savedItems.clear();
            for (const item of data.items || []) state.savedItems.set(item.key, item);
            state.savedSources = new Set(data.savedSources || [...state.savedItems.values()].map(i => i.sourceKey));
            state.collections = data.collections || []; state.trashBytes = Number(data.trashBytes) || 0; state.storageBytes = Number(data.bytes) || 0; state.limitBytes = Number(data.limitBytes) || 0;
            if (state.collection && !state.collections.some(c => c.id === state.collection)) state.collection = '';
            state.libraryNext = data.nextOffset; state.libraryRevision = data.revision;
            state.projects = [...new Map([...state.projects, ...(data.projects || [])].map(p => [p.key, p])).values()]; projectOptions();
        }
        async function load(reset) {
            if (!state.active || state.mutating) return;
            state.controller?.abort(); state.controller = new AbortController(); state.thumbnailController?.abort(); viewer.close();
            const epoch = ++state.epoch;
            if (reset) { disposeThumbnails(); state.items.clear(); state.projects = []; state.selected.clear(); state.next = null; state.snapshot = null; state.page = 0; }
            state.failed = false; state.loading = true; notice.hidden = true; render();
            const params = new URLSearchParams();
            if (state.cwd) params.set('cwd', state.cwd); if (state.sessionId) params.set('sessionId', state.sessionId);
            if (!reset && state.snapshot) { params.set('snapshot', state.snapshot); params.set('offset', String(state.next)); }
            try {
                if (reset || state.libraryNext != null) await loadSaved(reset);
                if (!reset && state.next == null) return;
                const data = await api('/api/pi/artifacts?' + params, { signal: state.controller.signal });
                if (epoch !== state.epoch || !state.active) return;
                for (const item of data.items || []) if (item.files?.length && HEX.test(item.key)) state.items.set(item.key, item);
                state.projects = [...new Map([...state.projects, ...(data.projects || [])].map(p => [p.key, p])).values()]; state.next = data.nextOffset; state.snapshot = data.snapshot; projectOptions();
                if (data.partial) showNotice(tr('正在展示部分结果：个别来源不可读或达到扫描上限，这不表示其他成果不存在。可以按项目筛选后单独发现，或稍后刷新。', 'Showing partial results: some sources could not be read or a scan limit was reached; other artifacts may still exist. Filter by project to focus discovery, or refresh later.'));
                else if (state.next != null && state.view === 'all') showNotice(tr('已读取一批来源，搜索和筛选只作用于已发现的结果。', 'A batch of sources is ready. Search and filters apply to what has been discovered.'), tr('继续发现', 'Discover more'), () => { void load(false); });
            } catch (error) { if (epoch === state.epoch && error.name !== 'AbortError') { state.failed = true; showNotice(error.message, tr('重试', 'Try again'), () => { void load(true); }, true); } }
            finally { if (epoch === state.epoch) { state.loading = false; render(); void thumbnails(); } }
        }
        function showNotice(text, actionLabel, action, error) {
            notice.hidden = false; noticeText.textContent = text; notice.classList.toggle('is-error', Boolean(error));
            noticeAction.hidden = !action; if (action) { noticeAction.textContent = actionLabel; noticeAction.onclick = () => { notice.hidden = true; action(); }; }
        }
        // ---------- Events ----------
        document.addEventListener('keydown', e => {
            if (!state.active || document.querySelector('dialog[open]')) return;
            const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
            if (e.key === 'Escape') { if (ui.closeMenus(true)) return; help.open = false; if (state.selecting && !state.mutating) { setSelecting(false); selectMode.focus(); } return; }
            if (typing || e.altKey) return;
            if (e.key === '/' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); search.focus(); search.select(); }
            else if (state.selecting && (e.key === 'Delete' || e.key === 'Backspace') && state.selected.size && ACTIONS[state.view]?.[0].includes('delete')) { e.preventDefault(); runBatch('delete'); }
            else if (state.selecting && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); togglePage(); }
        });
        document.addEventListener('click', e => { if (help.open && !help.contains(e.target)) help.open = false; });
        document.addEventListener('artifacts:mutation-state', e => { if (state.active) { if (e.detail?.stale) void load(true); else { paintChrome(visibleItems()); paintSelection(); } } });
        collectionFilter.addEventListener('change', () => {
            if (collectionFilter.value === '__new__') { collectionFilter.value = state.collection || ''; void manager.run('collection-create'); return; }
            state.collection = collectionFilter.value; if (state.collection && !['saved', 'favorite', 'hidden'].includes(state.view)) state.view = 'saved'; resetPage(); render();
        });
        search.addEventListener('input', () => { state.query = search.value; resetPage(); render(); });
        search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; state.query = ''; resetPage(); render(); } });
        projects.addEventListener('change', () => {
            state.project = projects.value; resetPage();
            const selected = state.projects.find(p => p.key === state.project);
            if (selected) window.PiWorkspaceRoute.navigate('artifacts', { cwd: selected.cwd });
            else if (state.cwd || state.sessionId) window.PiWorkspaceRoute.navigate('artifacts');
            else render();
        });
        function route(detail) {
            const active = detail?.tab === 'artifacts';
            if (!active) {
                if (state.active) { state.active = false; state.epoch++; state.controller?.abort(); state.loading = false; viewer.close(); disposeThumbnails(); ui.closeMenus(); }
                return;
            }
            state.active = true;
            if (state.mutating) state.epoch++;
            if (!state.availableProjects.length) void api('/api/pi/projects').then(data => {
                if (state.active) state.availableProjects = (data.projects || []).filter(p => p.cwd);
            }).catch(() => {});
            const previousCwd = state.cwd; state.cwd = detail.params?.get('cwd') || ''; state.sessionId = detail.params?.get('sessionId') || '';
            if (previousCwd !== state.cwd && !state.cwd && state.project !== 'unknown') state.project = '';
            state.scope = state.sessionId ? JSON.stringify([state.cwd, state.sessionId]) : ''; if (state.sessionId) state.view = 'all';
            // A returning page refreshes branch/history eligibility, not stale blobs.
            void load(true);
        }
        window.addEventListener('workspace:tabchanged', e => route(e.detail));
        window.addEventListener('workspace:artifacts-invalidated', () => { if (state.active) void load(true); });
        window.addEventListener('pagehide', () => { state.active = false; state.epoch++; state.controller?.abort(); viewer.close(); disposeThumbnails(); });
        route(window.PiWorkspaceRoute?.current());
    });
})();
