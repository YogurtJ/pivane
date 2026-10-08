/* Independent artifact library plus explicitly saved source results. */
(() => {
    const tr = (zh, en) => window.PiI18n?.locale?.startsWith('en') ? en : zh;
    const node = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const button = (label, fn, cls = '') => { const n = node('button', label, cls); n.type = 'button'; n.addEventListener('click', fn); return n; };
    const labels = () => ({ all: tr('全部成果', 'All artifacts'), document: tr('文档与表格', 'Documents'), image: tr('图像', 'Images'), video: tr('视频', 'Videos'), audio: tr('音频', 'Audio'), web: tr('网页', 'Web pages'), other: tr('其他', 'Other') });
    const icons = { document: 'fa-file-lines', image: 'fa-image', video: 'fa-film', audio: 'fa-wave-square', web: 'fa-window-maximize', other: 'fa-file-zipper' };
    async function api(url, options = {}) {
        const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store' });
        let data; try { data = await response.json(); } catch { throw new Error(tr('无法读取成果服务响应', 'Unable to read the artifacts response')); }
        if (!response.ok) throw new Error(data.error || tr('成果暂时无法读取', 'Artifacts are temporarily unavailable'));
        return data;
    }
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('[data-artifacts-label]').forEach(label => { label.textContent = tr('成果中心', 'Artifacts'); });
        const page = document.getElementById('artifacts-tab'); if (!page) return;
        const state = { items: new Map(), savedItems: new Map(), savedSources: new Set(), collections: [], availableProjects: [], selected: new Map(), view: 'saved', selecting: false, libraryNext: null, libraryRevision: null, mutating: false, projects: [], type: 'all', project: '', query: '', page: 0, active: false, loading: false, epoch: 0, scope: '', next: null, snapshot: null, urls: new Set(), thumbs: new Map(), thumbnailQueue: [], queued: new Set() };
        const viewer = new window.PiArtifactPreview(api);
        const message = value => { notice.hidden = false; noticeText.textContent = value; };
        const manager = new window.PiArtifactManager(api, state, async result => {
            const openKey = viewer.dialog.open ? viewer.file?.key : null;
            const failed = new Set((result.results || []).filter(r => !r.ok).map(r => r.key));
            for (const key of state.selected.keys()) if (!failed.has(key)) state.selected.delete(key);
            await loadSaved(true); render();
            if (openKey && viewer.dialog.open) { const item = [...state.savedItems.values()].find(i => i.key === openKey || i.sourceKey === openKey); if (item) viewer.open(item); else viewer.close(); }
        }, message);
        viewer.manage = async (action, file) => {
            const item = [...state.savedItems.values()].find(i => i.key === file.key);
            const target = { ...file, revision: item?.revision };
            if (action === 'location') return manager.location(target);
            return manager.run(action, [target], action === 'favorite' ? { favorite: !item?.favorite } : {});
        };
        const mediaHeader = document.querySelector('#media-tab .lab-header');
        if (mediaHeader) {
            const back = button(tr('成果库', 'Artifact library'), () => window.PiWorkspaceRoute.navigate('artifacts'), 'lab-secondary');
            back.id = 'lab-open-artifacts'; mediaHeader.append(back);
        }
        const header = node('header', null, 'artifacts-header'), intro = node('div');
        intro.append(node('div', 'PIVANE / ARTIFACTS', 'artifacts-eyebrow'), node('h1', tr('成果中心', 'Artifacts')),
            node('p', tr('保存有价值的结果，在这里查找、整理和使用。', 'Keep useful results. Find, organize and use them here.')));
        const create = button(tr('打开创作工具', 'Open creative tools'), () => window.PiWorkspaceRoute.navigate('media'), 'artifacts-primary');
        header.append(intro, create);
        const views = node('nav', null, 'artifacts-views'); views.setAttribute('aria-label', tr('成果与创作', 'Artifacts and creation'));
        for (const [id, label] of [['saved', tr('已保存', 'Saved')], ['favorite', tr('星标', 'Starred')], ['all', tr('待保存', 'Unsaved')], ['trash', tr('回收站', 'Trash')], ['hidden', tr('已隐藏', 'Hidden')]]) {
            const b = button(label, () => { notice.hidden = true; state.view = id; state.collection = ''; state.page = 0; state.selected.clear(); state.selecting = false; batchMore.open = false; render(); }); b.dataset.view = id; views.append(b);
        }
        const help = node('details', null, 'artifacts-help'); help.append(node('summary', tr('保存、星标和合集有什么区别？', 'Saving, stars and collections')));
        const helpText = node('div');
        for (const [title, description] of [[tr('保存', 'Save'), tr('保留独立文件。删除聊天后，成果仍在。', 'Keeps an independent file, even after deleting its conversation.')], [tr('星标', 'Star'), tr('标记常用成果，方便快速找到。取消星标不删除文件。', 'Marks frequently used work. Removing a star does not delete it.')], [tr('合集', 'Collection'), tr('按主题分组，不是磁盘文件夹。同一成果可加入多个合集。', 'Groups work by topic, not by disk location. One artifact can belong to several collections.')]]) { const p = node('p'); p.append(node('strong', title), node('span', description)); helpText.append(p); } help.append(helpText);
        const toolbar = node('div', null, 'artifacts-toolbar');
        const searchLabel = node('label', null, 'artifacts-search'), searchIcon = node('i', null, 'fa-solid fa-magnifying-glass'); searchIcon.setAttribute('aria-hidden', 'true');
        const search = node('input'); search.id = 'artifacts-search'; search.type = 'search'; search.maxLength = 200; search.placeholder = tr('搜索成果名称、文件或模型', 'Search titles, files or models'); search.setAttribute('aria-label', search.placeholder);
        searchLabel.append(searchIcon, search);
        const projects = node('select'); projects.id = 'artifacts-project'; projects.setAttribute('aria-label', tr('项目标签', 'Project label'));
        const refresh = button(tr('刷新', 'Refresh'), () => { void load(true); }, 'artifacts-refresh'); refresh.id = 'artifacts-refresh';
        const collectionFilter = node('select'); collectionFilter.id = 'artifacts-collection'; collectionFilter.setAttribute('aria-label', tr('合集', 'Collection'));
        const selectMode = button(tr('选择文件', 'Select files'), () => { state.selecting = !state.selecting; if (!state.selecting) state.selected.clear(); batchMore.open = false; render(); }, 'artifacts-select-toggle'); selectMode.id = 'artifacts-select';
        const filters = node('details', null, 'artifacts-filters'); filters.append(node('summary', tr('筛选与合集', 'Filters & collections')));
        const filterBody = node('div', null, 'artifacts-filter-body');
        const projectLabel = node('label', tr('项目标签', 'Project label')); projectLabel.append(projects);
        const collectionLabel = node('label', tr('按合集查看', 'View collection')); collectionLabel.append(collectionFilter);
        const collectionTools = node('div', null, 'artifacts-collection-tools');
        collectionTools.append(button(tr('新建合集', 'New collection'), () => { void manager.run('collection-create'); }), button(tr('重命名合集', 'Rename collection'), () => { if (state.collection) void manager.run('collection-rename', [], { collectionId: state.collection, name: state.collections.find(c => c.id === state.collection)?.name }); }),
            button(tr('删除合集', 'Delete collection'), () => { if (state.collection) void manager.run('collection-delete', [], { collectionId: state.collection }); }));
        const resetFilters = button(tr('清除筛选', 'Clear filters'), () => { state.collection = ''; state.project = ''; state.type = 'all'; state.query = ''; search.value = ''; state.selected.clear(); state.page = 0; if (state.cwd) window.PiWorkspaceRoute.navigate('artifacts'); else render(); }); resetFilters.className = 'artifacts-filter-reset';
        filterBody.append(projectLabel, collectionLabel, collectionTools, resetFilters); filters.append(filterBody);
        toolbar.append(searchLabel, filters, refresh);
        const batchbar = node('div', null, 'artifacts-batchbar'); batchbar.id = 'artifacts-batchbar'; batchbar.setAttribute('aria-label', tr('所选文件操作', 'Selected file actions'));
        const selectedCount = node('strong'); selectedCount.setAttribute('aria-live', 'polite');
        const selectPage = button(tr('全选本页', 'Select page'), () => { const files = visibleItems().slice(state.page * 36, state.page * 36 + 36).flatMap(i => i.files.map(f => ({ ...f, revision: i.revision }))); const all = files.every(f => state.selected.has(f.key)); if (all) files.forEach(f => state.selected.delete(f.key)); else for (const f of files) { if (state.selected.size >= 50) break; state.selected.set(f.key, f); } render(); });
        const clearSelection = button(tr('清除选择', 'Clear'), () => { state.selected.clear(); render(); }); clearSelection.id = 'artifacts-clear-selection';
        const selectionInfo = node('div', null, 'artifacts-selection-info'); selectionInfo.append(selectedCount, selectPage, clearSelection);
        const batchActions = node('div', null, 'artifacts-batch-actions');
        const batchHint = node('span', tr('选择下方文件，可一次处理最多 50 个。', 'Choose up to 50 files below.'), 'artifacts-selection-hint');
        const batchMore = node('details', null, 'artifacts-batch-more'); batchMore.append(node('summary', tr('更多操作', 'More'))); const moreActions = node('div', null, 'artifacts-more-actions'); batchMore.append(moreActions);
        batchbar.append(selectionInfo, batchHint, batchActions);
        for (const [action, label] of [['save', tr('保存', 'Save')], ['favorite', tr('加星标', 'Star')], ['collection-add', tr('加入合集', 'Add to collection')], ['collection-remove', tr('移出此合集', 'Remove from collection')], ['project', tr('设置项目标签…', 'Set project label…')], ['export', tr('导出到服务器…', 'Export to server…')], ['hide', tr('隐藏', 'Hide')], ['unhide', tr('取消隐藏', 'Unhide')], ['trash', tr('移入回收站', 'Move to trash')], ['restore', tr('恢复', 'Restore')], ['purge', tr('永久删除', 'Delete permanently')]]) {
            const b = button(label, () => { batchMore.open = false; void manager.run(action, [...state.selected.values()], action === 'favorite' ? { favorite: !allStarred() } : action === 'collection-remove' ? { collectionId: state.collection } : {}); }); b.dataset.action = action;
            (['project', 'export', 'hide', 'unhide', 'collection-remove'].includes(action) ? moreActions : batchActions).append(b);
        }
        batchActions.append(batchMore);
        const viewNote = node('p', null, 'artifacts-view-note');
        const types = node('div', null, 'artifacts-types'); types.setAttribute('role', 'group'); types.setAttribute('aria-label', tr('成果类型', 'Artifact type'));
        for (const [key, label] of Object.entries(labels())) { const b = button(label, () => { notice.hidden = true; state.type = key; state.page = 0; state.selected.clear(); render(); }); b.dataset.kind = key; types.append(b); }
        const summary = node('div', null, 'artifacts-summary'), count = node('strong'), scope = node('span'); summary.append(count, scope, selectMode);
        const notice = node('div', '', 'artifacts-notice'); const noticeText = node('span'); noticeText.setAttribute('role', 'status'); const dismiss = button('×', () => { notice.hidden = true; }); dismiss.setAttribute('aria-label', tr('关闭提示', 'Dismiss message')); notice.append(noticeText, dismiss); notice.hidden = true;
        const grid = node('div', null, 'artifacts-grid'); grid.id = 'artifacts-grid';
        const empty = node('div', null, 'artifacts-empty'), emptyIcon = node('i', null, 'fa-regular fa-folder-open'); emptyIcon.setAttribute('aria-hidden', 'true');
        const emptyTitle = node('h2'), emptyText = node('p'); const discover = button(tr('查看待保存成果', 'Browse unsaved results'), () => { state.view = 'all'; state.collection = ''; render(); }, 'artifacts-primary'); empty.append(emptyIcon, emptyTitle, emptyText, discover);
        const footer = node('div', null, 'artifacts-footer');
        const more = button(tr('继续发现来源', 'Discover more sources'), () => { void load(false); }); more.id = 'artifacts-more';
        const previous = button(tr('上一页', 'Previous'), () => { state.page--; state.selected.clear(); render(); grid.scrollIntoView({ block: 'start' }); });
        const next = button(tr('下一页', 'Next'), () => { state.page++; state.selected.clear(); render(); grid.scrollIntoView({ block: 'start' }); });
        const pageCount = node('span'); footer.append(previous, pageCount, next, more);
        const footnote = node('p', tr('只汇集明确交付与媒体生成结果。不会收录全部源码改动、上传附件或聊天路径；此页面不会移动或删除原文件。', 'Explicit deliveries and generated media only—not every code change, upload or path mentioned in chat. This page never moves or deletes originals.'), 'artifacts-footnote');
        footnote.textContent = tr('成果库与聊天分开管理。这里只管理库内副本，不删除来源聊天、原文件或媒体历史。', 'The library is separate from conversations. Actions here affect library copies, not source conversations, original files or media history.');
        page.append(header, views, viewNote, toolbar, types, summary, notice, batchbar, grid, empty, footer, help, footnote);
        const observer = new IntersectionObserver(entries => {
            for (const entry of entries) if (entry.isIntersecting) {
                const key = entry.target.dataset.key; observer.unobserve(entry.target);
                if (!state.queued.has(key)) { state.queued.add(key); state.thumbnailQueue.push(key); }
            }
            void thumbnails();
        }, { root: page, rootMargin: '80px' });
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
                        const cover = grid.querySelector(`[data-key="${key}"] .artifacts-cover`); if (cover) applyThumb(cover, url);
                    } catch { /* A cover is optional. A real open surfaces source errors. */ }
                }
            } finally { state.thumbnailBusy = false; if (state.active && epoch !== state.epoch && state.thumbnailQueue.length) void thumbnails(); }
        }
        function applyThumb(cover, url) { const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.src = url; cover.classList.add('has-image'); cover.prepend(image); }
        function projectOptions() {
            projects.replaceChildren();
            const option = (value, label) => { const o = node('option', label); o.value = value; projects.append(o); };
            option('', tr('全部项目', 'All projects')); option('unknown', tr('无项目标签', 'No project label'));
            for (const item of state.projects) { option(item.key, item.name); projects.lastChild.title = item.cwd; }
            if (state.cwd) { const p = state.projects.find(p => p.cwd === state.cwd); if (p) state.project = p.key; }
            if (state.project !== 'unknown' && ![...projects.options].some(o => o.value === state.project)) state.project = '';
            projects.value = state.project;
        }
        function visibleItems() {
            const represented = state.savedSources;
            const raw = [...state.items.values()].map(item => ({ ...item, files: item.files.filter(f => !represented.has(f.key)) })).filter(i => i.files.length);
            const saved = [...state.savedItems.values()].filter(i => state.view === 'trash' ? i.trashedAt : state.view === 'hidden' ? !i.trashedAt && i.hiddenAt : !i.trashedAt && !i.hiddenAt);
            const all = state.view === 'all' ? raw : saved;
            const query = state.query.trim().toLocaleLowerCase();
            return all.filter(item => (state.view !== 'favorite' || item.favorite) && (!state.collection || item.collections?.includes(state.collection))
                && (state.type === 'all' || item.types.includes(state.type))
                && (!state.project || (state.project === 'unknown' ? !item.project : item.project?.key === state.project))
                && (!state.sessionId || item.origin?.sessionId === state.sessionId)
                && (!query || [item.title, item.project?.name || '', item.model || '', ...item.files.flatMap(f => [f.name, f.originalName || ''])].join(' ').toLocaleLowerCase().includes(query)))
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        }
        function allStarred() { return state.selected.size > 0 && [...state.selected.keys()].every(key => state.savedItems.get(key)?.favorite); }
        function render() {
            const focusedKey = document.activeElement?.dataset.selectionKey || document.activeElement?.dataset.key;
            const wasCheckbox = document.activeElement?.type === 'checkbox';
            observer.disconnect(); state.thumbnailQueue = []; state.queued.clear();
            types.querySelectorAll('button').forEach(b => { b.setAttribute('aria-pressed', String(b.dataset.kind === state.type)); b.disabled = state.mutating; });
            views.querySelectorAll('button').forEach(b => { b.disabled = state.mutating; });
            search.disabled = projects.disabled = collectionFilter.disabled = state.mutating;
            const query = state.query.trim().toLocaleLowerCase();
            const items = visibleItems();
            state.page = Math.max(0, Math.min(state.page, Math.ceil(items.length / 36) - 1));
            views.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
            summary.hidden = state.selecting; batchbar.hidden = !state.selecting;
            (state.selecting ? batchbar : summary).append(selectMode);
            selectMode.textContent = state.selecting ? tr('完成', 'Done') : tr('选择文件', 'Select files'); selectMode.setAttribute('aria-pressed', String(state.selecting)); selectMode.disabled = state.mutating;
            selectedCount.textContent = state.mutating ? tr('正在处理…', 'Working…') : tr(`已选 ${state.selected.size} 个`, `${state.selected.size} selected`);
            batchHint.hidden = state.selected.size > 0; batchActions.hidden = !state.selected.size; clearSelection.hidden = !state.selected.size;
            selectPage.disabled = clearSelection.disabled = state.mutating;
            const pageFiles = items.slice(state.page * 36, state.page * 36 + 36).flatMap(i => i.files);
            selectPage.textContent = pageFiles.length && pageFiles.every(f => state.selected.has(f.key)) ? tr('取消本页', 'Deselect page') : tr('全选本页', 'Select page');
            const allowed = state.view === 'trash' ? ['restore', 'purge'] : state.view === 'all' ? ['save', 'favorite', 'collection-add'] : ['favorite', 'collection-add', 'project', 'export', 'trash', ...(state.view === 'hidden' ? ['unhide'] : ['hide']), ...(state.collection ? ['collection-remove'] : [])];
            batchbar.querySelectorAll('[data-action]').forEach(b => { b.disabled = !state.selected.size || state.mutating; b.hidden = !allowed.includes(b.dataset.action); if (b.dataset.action === 'favorite') b.textContent = allStarred() ? tr('取消星标', 'Unstar') : state.view === 'all' ? tr('保存并加星标', 'Save & star') : tr('加星标', 'Star'); });
            batchMore.hidden = ![...moreActions.children].some(b => !b.hidden);
            batchbar.classList.toggle('is-working', state.mutating);
            viewNote.textContent = state.view === 'all' ? tr('来自聊天交付和媒体生成，尚未独立保存。保存后，删除聊天也不会丢失。', 'Results from conversations and media generation, not yet saved independently. Save before deleting the source.') : state.view === 'trash' ? tr('回收站仍占用空间。恢复后可继续使用，永久删除会释放成果库副本且无法撤销。', 'Trash still uses space. Restore to use files again, or delete library copies permanently to free space.') : state.view === 'favorite' ? tr('标记常用成果，随时快速找到。取消星标不会删除文件。', 'Your frequently used work. Removing a star keeps the file.') : state.view === 'hidden' ? tr('隐藏的成果仍然保留，可随时取消隐藏。', 'Hidden artifacts are kept. Unhide them at any time.') : tr('已保留独立副本，不随来源聊天删除。用星标快速查找，用合集按主题整理。', 'Independent copies, kept even if the source conversation is deleted. Star for quick access; collect by topic.');
            collectionFilter.replaceChildren();
            for (const c of [{ id: '', name: tr('全部合集', 'All collections') }, ...state.collections]) { const o = node('option', c.name); o.value = c.id; collectionFilter.append(o); } collectionFilter.value = state.collection || '';
            filters.querySelector('summary').textContent = state.collection ? state.collections.find(c => c.id === state.collection)?.name || tr('合集', 'Collection') : state.project ? tr('已筛选项目', 'Project filtered') : tr('筛选与合集', 'Filters & collections');
            filters.classList.toggle('has-filter', Boolean(state.collection || state.project));
            collectionTools.querySelectorAll('button').forEach((b, i) => { b.hidden = i > 0 && !state.collection; b.disabled = state.mutating || (i > 0 && !state.collection); });
            resetFilters.disabled = state.mutating;
            state.page = Math.max(0, Math.min(state.page, Math.ceil(items.length / 36) - 1));
            grid.replaceChildren(); empty.hidden = items.length > 0;
            count.textContent = `${items.length.toLocaleString()} ${tr('项成果', 'artifacts')}`;
            scope.textContent = state.view === 'trash' && state.trashBytes ? tr(`占用 ${(state.trashBytes / 1024 / 1024).toFixed(1)} MB`, `${(state.trashBytes / 1024 / 1024).toFixed(1)} MB used`) : state.collection ? state.collections.find(c => c.id === state.collection)?.name || '' : state.scope ? tr('当前会话', 'This conversation') : '';
            discover.hidden = state.view !== 'saved' || items.length > 0 || Boolean(query || state.type !== 'all' || state.project || state.collection);
            if (state.loading && !state.items.size) { emptyTitle.textContent = tr('正在发现成果', 'Discovering artifacts'); emptyText.textContent = tr('只读核对来源，不会启动会话 Agent。', 'Checking sources read-only. No conversation agents are started.'); }
            else if (state.failed && !state.items.size) { emptyTitle.textContent = tr('成果暂时无法读取', 'Artifacts are temporarily unavailable'); emptyText.textContent = tr('来源未被修改。请稍后刷新，或回到来源会话查看。', 'Sources were not changed. Refresh later or open the source conversation.'); }
            else if (query || state.type !== 'all' || state.project) { emptyTitle.textContent = tr('没有匹配的成果', 'No matching artifacts'); emptyText.textContent = tr('试试其他关键词或筛选条件；也可继续发现来源。', 'Try another search or filter, or discover more sources.'); }
            else { emptyTitle.textContent = tr('你的成果，会在这里相遇', 'Your work, together in one place'); emptyText.textContent = tr('让 Agent 明确交付报告、网页或文件，或前往创作工具生成媒体。上传的参考素材不会自动出现在这里。', 'Ask your Agent to deliver a report, web page or file, or generate media in Creative tools. Uploaded references are not automatically included.'); }
            if (!items.length && !state.loading && !state.failed && !query && state.type === 'all' && !state.project) {
                const messages = { saved: [tr('把值得保留的结果存下来', 'Keep your best results'), tr('从「待保存」中选择文件，保存后就能在这里独立管理。', 'Choose results in Unsaved and save them here.')], favorite: [tr('还没有星标成果', 'No starred artifacts'), tr('点文件上的星形按钮，把常用成果放在这里。', 'Use the star on an artifact to find it quickly here.')], trash: [tr('回收站是空的', 'Trash is empty'), tr('移入回收站的成果可恢复，也可永久删除。', 'Trashed artifacts can be restored or permanently deleted.')], hidden: [tr('没有隐藏的成果', 'No hidden artifacts'), tr('隐藏只影响展示，不会删除文件。', 'Hiding changes visibility without deleting files.')] };
                if (messages[state.view]) [emptyTitle.textContent, emptyText.textContent] = messages[state.view];
            }
            for (const item of items.slice(state.page * 36, state.page * 36 + 36)) {
                const file = item.files[0], kind = item.types[0] || 'other';
                const displayTitle = item.source === 'media' && item.title === file.name ? (item.model || labels()[kind]) : item.title || file.name;
                const wrapper = node('div', null, 'artifacts-card-wrap');
                const card = button('', e => {
                    if (state.mutating) return;
                    if (state.selecting) {
                        if (e.shiftKey && state.anchor) {
                            const keys = items.flatMap(i => i.files.map(f => ({ ...f, revision: i.revision }))), start = keys.findIndex(f => f.key === state.anchor), end = keys.findIndex(f => f.key === file.key);
                            if (start >= 0 && end >= 0) for (const f of keys.slice(Math.min(start, end), Math.max(start, end) + 1)) { if (state.selected.size >= 50) break; state.selected.set(f.key, f); }
                        } else for (const f of item.files) { if (state.selected.has(f.key)) state.selected.delete(f.key); else if (state.selected.size < 50) state.selected.set(f.key, { ...f, revision: item.revision }); }
                        state.anchor = file.key; render(); return;
                    }
                    state.thumbnailController?.abort(); state.thumbnailQueue = []; viewer.open({ ...item, title: displayTitle });
                }, 'artifacts-card'); card.dataset.key = file.key; card.setAttribute('aria-label', displayTitle); if (state.selecting) card.setAttribute('aria-pressed', String(item.files.every(f => state.selected.has(f.key))));
                if (state.selecting) { const choices = node('div', null, 'artifacts-file-choices'); choices.classList.toggle('is-single', item.files.length === 1); for (const f of item.files) { const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.dataset.selectionKey = f.key; checkbox.checked = state.selected.has(f.key); checkbox.disabled = state.mutating || (!checkbox.checked && state.selected.size >= 50); checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.set(f.key, { ...f, revision: item.revision }); else state.selected.delete(f.key); render(); }); label.append(checkbox, node('span', f.name)); choices.append(label); } wrapper.append(choices); }
                else if (!item.trashedAt && item.files.length === 1) { const star = button(item.favorite ? '★' : '☆', () => { void manager.run('favorite', [{ ...file, revision: item.revision }], { favorite: !item.favorite }); }, 'artifacts-star'); star.setAttribute('aria-label', item.favorite ? tr('取消星标', 'Unstar') : item.independent ? tr('加星标', 'Star') : tr('保存并加星标', 'Save and star')); star.title = star.getAttribute('aria-label'); star.setAttribute('aria-pressed', String(Boolean(item.favorite))); star.disabled = state.mutating; wrapper.append(star); }
                wrapper.classList.toggle('is-selected', item.files.some(f => state.selected.has(f.key)));
                const cover = node('div', null, `artifacts-cover artifacts-cover-${kind}`), icon = node('i', null, 'fa-regular ' + (icons[kind] || icons.other));
                icon.className = 'fa-solid ' + (icons[kind] || icons.other); icon.setAttribute('aria-hidden', 'true'); cover.append(icon);
                cover.append(node('span', labels()[kind], 'artifacts-format'));
                if (item.files.length > 1) cover.append(node('span', `${item.files.length} ${tr('个文件', 'files')}`, 'artifacts-stack'));
                if (state.thumbs.has(file.key)) applyThumb(cover, state.thumbs.get(file.key));
                const content = node('div', null, 'artifacts-card-content'); content.append(node('h2', displayTitle));
                content.append(node('p', item.files.map(f => f.name).join(' · '), 'artifacts-filenames'));
                const meta = node('div', null, 'artifacts-card-meta'); meta.append(node('span', item.project?.name || tr('无项目标签', 'No project label')));
                const date = node('time', item.createdAt ? new Date(item.createdAt).toLocaleDateString(window.PiI18n?.locale || 'zh-CN', { month: 'short', day: 'numeric' }) : tr('历史记录', 'Historical')); if (item.createdAt) date.dateTime = item.createdAt;
                meta.append(date); content.append(meta);
                content.append(node('span', item.deletionPending ? tr('删除待核对', 'Deletion needs review') : item.trashedAt ? tr('在回收站', 'In trash') : item.independent ? tr('已保存', 'Saved') : tr('待保存', 'Not saved'), 'artifacts-save-state'));
                card.append(cover, content); wrapper.append(card); grid.append(wrapper);
                if (kind === 'image' && !state.thumbs.has(file.key)) observer.observe(card);
            }
            previous.hidden = state.page === 0; next.hidden = (state.page + 1) * 36 >= items.length;
            pageCount.textContent = items.length > 36 ? `${state.page + 1} / ${Math.ceil(items.length / 36)}` : '';
            more.textContent = state.libraryNext != null ? tr('加载更多成果', 'Load more artifacts') : tr('继续发现来源', 'Discover more sources');
            more.hidden = state.view !== 'all' ? state.libraryNext == null : state.next == null && state.libraryNext == null; more.disabled = state.loading || state.mutating; refresh.disabled = state.loading || state.mutating;
            grid.setAttribute('aria-busy', String(state.loading));
            if (focusedKey && /^[a-f0-9]{64}$/.test(focusedKey)) grid.querySelector(wasCheckbox ? `[data-selection-key="${focusedKey}"]` : `[data-key="${focusedKey}"]`)?.focus({ preventScroll: true });
        }
        async function loadSaved(reset) {
            const epoch = state.epoch;
            const params = new URLSearchParams(); if (!reset && state.libraryNext != null) { params.set('offset', state.libraryNext); params.set('revision', state.libraryRevision); }
            const data = await api('/api/pi/artifacts/library?' + params, { signal: state.controller?.signal });
            if (epoch !== state.epoch || !state.active) return;
            if (reset) state.savedItems.clear();
            for (const item of data.items || []) state.savedItems.set(item.key, item);
            state.savedSources = new Set(data.savedSources || [...state.savedItems.values()].map(i => i.sourceKey));
            state.collections = data.collections || []; state.trashBytes = Number(data.trashBytes) || 0; state.storageBytes = Number(data.bytes) || 0;
            if (state.collection && !state.collections.some(c => c.id === state.collection)) state.collection = '';
            state.libraryNext = data.nextOffset; state.libraryRevision = data.revision;
            state.projects = [...new Map([...state.projects, ...(data.projects || [])].map(p => [p.key, p])).values()]; projectOptions();
        }
        async function load(reset) {
            if (!state.active || state.mutating) return;
            state.controller?.abort(); state.controller = new AbortController(); state.thumbnailController?.abort(); viewer.close();
            const epoch = ++state.epoch;
            if (reset) { disposeThumbnails(); state.items.clear(); state.projects = []; state.selected.clear(); state.next = null; state.snapshot = null; state.page = 0; }
            state.failed = false;
            state.loading = true; notice.hidden = true; render();
            const params = new URLSearchParams();
            if (state.cwd) params.set('cwd', state.cwd); if (state.sessionId) params.set('sessionId', state.sessionId);
            if (!reset && state.snapshot) { params.set('snapshot', state.snapshot); params.set('offset', String(state.next)); }
            try {
                if (reset || state.libraryNext != null) await loadSaved(reset);
                if (!reset && state.next == null) return;
                const data = await api('/api/pi/artifacts?' + params, { signal: state.controller.signal });
                if (epoch !== state.epoch || !state.active) return;
                for (const item of data.items || []) if (item.files?.length && /^[a-f0-9]{64}$/.test(item.key)) state.items.set(item.key, item);
                state.projects = [...new Map([...state.projects, ...(data.projects || [])].map(p => [p.key, p])).values()]; state.next = data.nextOffset; state.snapshot = data.snapshot; projectOptions();
                if (data.partial) { notice.hidden = false; noticeText.textContent = tr('正在展示部分结果：个别来源不可读或达到扫描预算。可在项目筛选中选择项目单独发现，或稍后刷新；这不表示其他成果不存在。', 'Partial results: some sources could not be read or a scan budget was reached. Select a project to focus discovery or refresh later; other artifacts may still exist.'); }
                else if (state.next != null) { notice.hidden = false; noticeText.textContent = tr('已读取一批有效来源，可继续发现更多会话成果。搜索与类型筛选作用于已发现结果。', 'A batch of valid sources is ready. Discover more conversation artifacts below. Search and type filters apply to discovered results.'); }
            } catch (error) { if (epoch === state.epoch && error.name !== 'AbortError') { state.failed = true; notice.hidden = false; noticeText.textContent = error.message; } }
            finally { if (epoch === state.epoch) { state.loading = false; render(); void thumbnails(); } }
        }
        document.addEventListener('click', e => { if (e.target.closest('dialog')) return; if (!filters.contains(e.target)) filters.open = false; if (!batchMore.contains(e.target)) batchMore.open = false; });
        document.addEventListener('keydown', e => { if (e.key !== 'Escape' || !state.active || state.mutating || document.querySelector('dialog[open]')) return; filters.open = false; batchMore.open = false; if (state.selecting) { state.selecting = false; state.selected.clear(); render(); selectMode.focus(); } });
        document.addEventListener('artifacts:mutation-state', e => { if (state.active) { if (e.detail?.stale) void load(true); else render(); } });
        collectionFilter.addEventListener('change', () => { state.collection = collectionFilter.value; if (state.collection) state.view = 'saved'; state.page = 0; state.selected.clear(); render(); });
        search.addEventListener('input', () => { state.query = search.value; state.page = 0; state.selected.clear(); render(); });
        projects.addEventListener('change', () => {
            state.project = projects.value; state.page = 0;
            const selected = state.projects.find(p => p.key === state.project);
            if (selected) window.PiWorkspaceRoute.navigate('artifacts', { cwd: selected.cwd });
            else if (state.cwd) window.PiWorkspaceRoute.navigate('artifacts');
            else render();
        });
        function route(detail) {
            const active = detail?.tab === 'artifacts';
            if (!active) {
                if (state.active) { state.active = false; state.epoch++; state.controller?.abort(); state.loading = false; viewer.close(); disposeThumbnails(); }
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
