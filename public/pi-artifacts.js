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
        const state = { items: new Map(), savedItems: new Map(), savedSources: new Set(), collections: [], availableProjects: [], selected: new Map(), view: 'all', selecting: false, libraryNext: null, libraryRevision: null, mutating: false, projects: [], type: 'all', project: '', query: '', page: 0, active: false, loading: false, epoch: 0, scope: '', next: null, snapshot: null, urls: new Set(), thumbs: new Map(), thumbnailQueue: [], queued: new Set() };
        const viewer = new window.PiArtifactPreview(api);
        const message = value => { notice.hidden = false; notice.textContent = value; };
        const manager = new window.PiArtifactManager(api, state, async () => {
            const openKey = viewer.dialog.open ? viewer.file?.key : null;
            state.selected.clear(); await loadSaved(true); render();
            if (openKey && viewer.dialog.open) { const item = [...state.savedItems.values()].find(i => i.key === openKey || i.sourceKey === openKey); if (item) viewer.open(item); }
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
            node('p', tr('让值得保留的产物，离开聊天也能被找到。', 'Good work deserves a place beyond the conversation.')));
        const create = button(tr('打开创作工具', 'Open creative tools'), () => window.PiWorkspaceRoute.navigate('media'), 'artifacts-primary');
        header.append(intro, create);
        const views = node('nav', null, 'artifacts-views'); views.setAttribute('aria-label', tr('成果与创作', 'Artifacts and creation'));
        for (const [id, label] of [['all', tr('全部', 'All')], ['saved', tr('已保存', 'Saved')], ['favorite', tr('收藏', 'Favorites')], ['trash', tr('回收站', 'Trash')], ['hidden', tr('已隐藏', 'Hidden')]]) {
            const b = button(label, () => { state.view = id; state.page = 0; state.selected.clear(); render(); }); b.dataset.view = id; views.append(b);
        }
        views.append(button(tr('创作工具', 'Creative tools'), () => window.PiWorkspaceRoute.navigate('media')));
        const toolbar = node('div', null, 'artifacts-toolbar');
        const searchLabel = node('label', null, 'artifacts-search'), searchIcon = node('i', null, 'fa-solid fa-magnifying-glass'); searchIcon.setAttribute('aria-hidden', 'true');
        const search = node('input'); search.id = 'artifacts-search'; search.type = 'search'; search.maxLength = 200; search.placeholder = tr('搜索成果名称、文件或模型', 'Search titles, files or models'); search.setAttribute('aria-label', search.placeholder);
        searchLabel.append(searchIcon, search);
        const projects = node('select'); projects.id = 'artifacts-project'; projects.setAttribute('aria-label', tr('来源项目', 'Source project'));
        const refresh = button(tr('刷新', 'Refresh'), () => { void load(true); }, 'artifacts-refresh'); refresh.id = 'artifacts-refresh';
        const collectionFilter = node('select'); collectionFilter.id = 'artifacts-collection'; collectionFilter.setAttribute('aria-label', tr('收藏夹', 'Collection'));
        const selectMode = button(tr('多选', 'Select'), () => { state.selecting = !state.selecting; if (!state.selecting) state.selected.clear(); render(); }, 'artifacts-refresh'); selectMode.id = 'artifacts-select';
        const collectionCreate = button(tr('新建收藏夹', 'New collection'), () => { void manager.run('collection-create'); }, 'artifacts-refresh');
        toolbar.append(searchLabel, projects, collectionFilter, refresh, selectMode);
        const collectionTools = node('div', null, 'artifacts-collection-tools');
        collectionTools.append(collectionCreate, button(tr('重命名收藏夹', 'Rename collection'), () => { if (state.collection) void manager.run('collection-rename', [], { collectionId: state.collection, name: state.collections.find(c => c.id === state.collection)?.name }); }),
            button(tr('删除收藏夹', 'Delete collection'), () => { if (state.collection) void manager.run('collection-delete', [], { collectionId: state.collection }); }));
        const batchbar = node('div', null, 'artifacts-batchbar'); batchbar.id = 'artifacts-batchbar';
        const selectedCount = node('strong'); batchbar.append(selectedCount);
        const selectPage = button(tr('选择当前页', 'Select current page'), () => { for (const item of visibleItems().slice(state.page * 36, state.page * 36 + 36)) for (const f of item.files) state.selected.set(f.key, { ...f, revision: item.revision }); render(); }); batchbar.append(selectPage);
        for (const [action, label] of [['save', tr('保存到成果库', 'Save')], ['favorite', tr('收藏', 'Favorite')], ['unfavorite', tr('取消收藏', 'Unfavorite')], ['collection-add', tr('加入收藏夹', 'Add to collection')], ['collection-remove', tr('移出收藏夹', 'Remove from collection')], ['project', tr('关联项目', 'Link project')], ['export', tr('保存到文件夹', 'Save to folder')], ['hide', tr('隐藏', 'Hide')], ['unhide', tr('取消隐藏', 'Unhide')], ['trash', tr('移入回收站', 'Trash')], ['restore', tr('恢复', 'Restore')]]) {
            const b = button(label, () => { void manager.run(action === 'unfavorite' ? 'favorite' : action, [...state.selected.values()], action === 'favorite' || action === 'unfavorite' ? { favorite: action === 'favorite' } : {}); }); b.dataset.action = action; batchbar.append(b);
        }
        const types = node('div', null, 'artifacts-types'); types.setAttribute('role', 'group'); types.setAttribute('aria-label', tr('成果类型', 'Artifact type'));
        for (const [key, label] of Object.entries(labels())) { const b = button(label, () => { state.type = key; state.page = 0; render(); }); b.dataset.kind = key; types.append(b); }
        const summary = node('div', null, 'artifacts-summary'), count = node('strong'), scope = node('span'); summary.append(count, scope);
        const notice = node('div', '', 'artifacts-notice'); notice.setAttribute('role', 'status'); notice.hidden = true;
        const grid = node('div', null, 'artifacts-grid'); grid.id = 'artifacts-grid';
        const empty = node('div', null, 'artifacts-empty'), emptyIcon = node('i', null, 'fa-regular fa-folder-open'); emptyIcon.setAttribute('aria-hidden', 'true');
        const emptyTitle = node('h2'), emptyText = node('p'); empty.append(emptyIcon, emptyTitle, emptyText);
        const footer = node('div', null, 'artifacts-footer');
        const more = button(tr('继续发现来源', 'Discover more sources'), () => { void load(false); }); more.id = 'artifacts-more';
        const previous = button(tr('上一页', 'Previous'), () => { state.page--; render(); grid.scrollIntoView({ block: 'start' }); });
        const next = button(tr('下一页', 'Next'), () => { state.page++; render(); grid.scrollIntoView({ block: 'start' }); });
        const pageCount = node('span'); footer.append(previous, pageCount, next, more);
        const footnote = node('p', tr('只汇集明确交付与媒体生成结果。不会收录全部源码改动、上传附件或聊天路径；此页面不会移动或删除原文件。', 'Explicit deliveries and generated media only—not every code change, upload or path mentioned in chat. This page never moves or deletes originals.'), 'artifacts-footnote');
        footnote.textContent = tr('会话负责交流，成果库负责保存。保存或收藏会创建独立副本；删除会话不删除已入库成果。成果回收站只管理库内副本。', 'Conversations communicate; the library preserves. Saving or favoriting creates an independent copy. Deleting a conversation never deletes saved artifacts. Artifact trash manages library copies only.');
        page.append(header, views, toolbar, collectionTools, types, summary, notice, batchbar, grid, empty, footer, footnote);
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
            option('', tr('全部项目', 'All projects')); option('unknown', tr('未关联项目', 'Unlinked project'));
            for (const item of state.projects) { option(item.key, item.name); projects.lastChild.title = item.cwd; }
            if (state.cwd) { const p = state.projects.find(p => p.cwd === state.cwd); if (p) state.project = p.key; }
            if (state.project !== 'unknown' && ![...projects.options].some(o => o.value === state.project)) state.project = '';
            projects.value = state.project;
        }
        function visibleItems() {
            const represented = state.savedSources;
            const raw = [...state.items.values()].map(item => ({ ...item, files: item.files.filter(f => !represented.has(f.key)) })).filter(i => i.files.length);
            const saved = [...state.savedItems.values()].filter(i => state.view === 'trash' ? i.trashedAt : state.view === 'hidden' ? !i.trashedAt && i.hiddenAt : !i.trashedAt && !i.hiddenAt);
            const all = [...saved, ...(state.view === 'all' && !state.collection ? raw : [])];
            const query = state.query.trim().toLocaleLowerCase();
            return all.filter(item => (state.view !== 'favorite' || item.favorite) && (!state.collection || item.collections?.includes(state.collection))
                && (state.type === 'all' || item.types.includes(state.type))
                && (!state.project || (state.project === 'unknown' ? !item.project : item.project?.key === state.project))
                && (!state.sessionId || item.origin?.sessionId === state.sessionId)
                && (!query || [item.title, item.project?.name || '', item.model || '', ...item.files.flatMap(f => [f.name, f.originalName || ''])].join(' ').toLocaleLowerCase().includes(query)))
                .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        }
        function render() {
            observer.disconnect(); state.thumbnailQueue = []; state.queued.clear();
            types.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.kind === state.type)));
            const query = state.query.trim().toLocaleLowerCase();
            const items = visibleItems();
            views.querySelectorAll('[data-view]').forEach(b => { if (b.dataset.view === state.view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
            batchbar.hidden = !state.selecting; selectMode.textContent = state.selecting ? tr('退出多选', 'Done selecting') : tr('多选', 'Select');
            selectedCount.textContent = `${state.selected.size} ${tr('个文件已选', 'files selected')}`;
            batchbar.querySelectorAll('[data-action]').forEach(b => { b.disabled = !state.selected.size || state.mutating; b.hidden = state.view === 'trash' ? b.dataset.action !== 'restore' : b.dataset.action === 'restore' || (b.dataset.action === 'unhide' && state.view !== 'hidden'); });
            collectionFilter.replaceChildren();
            for (const c of [{ id: '', name: tr('全部收藏夹', 'All collections') }, ...state.collections]) { const o = node('option', c.name); o.value = c.id; collectionFilter.append(o); } collectionFilter.value = state.collection || '';
            collectionTools.querySelectorAll('button').forEach((b, i) => { b.hidden = i > 0 && !state.collection; b.disabled = state.mutating || (i > 0 && !state.collection); });
            state.page = Math.max(0, Math.min(state.page, Math.ceil(items.length / 36) - 1));
            grid.replaceChildren(); empty.hidden = items.length > 0;
            count.textContent = `${items.length.toLocaleString()} ${tr('项成果', 'artifacts')}`;
            scope.textContent = state.scope ? tr('会话来源范围', 'Conversation scope') : state.view === 'all' ? tr('已保存 + 当前有效来源', 'Saved + Valid sources') : tr('独立保存 · 不随会话删除', 'Independent · Preserved beyond conversations');
            if (state.loading && !state.items.size) { emptyTitle.textContent = tr('正在发现成果', 'Discovering artifacts'); emptyText.textContent = tr('只读核对来源，不会启动会话 Agent。', 'Checking sources read-only. No conversation agents are started.'); }
            else if (state.failed && !state.items.size) { emptyTitle.textContent = tr('成果暂时无法读取', 'Artifacts are temporarily unavailable'); emptyText.textContent = tr('来源未被修改。请稍后刷新，或回到来源会话查看。', 'Sources were not changed. Refresh later or open the source conversation.'); }
            else if (query || state.type !== 'all' || state.project) { emptyTitle.textContent = tr('没有匹配的成果', 'No matching artifacts'); emptyText.textContent = tr('试试其他关键词或筛选条件；也可继续发现来源。', 'Try another search or filter, or discover more sources.'); }
            else { emptyTitle.textContent = tr('你的成果，会在这里相遇', 'Your work, together in one place'); emptyText.textContent = tr('让 Agent 明确交付报告、网页或文件，或前往创作工具生成媒体。上传的参考素材不会自动出现在这里。', 'Ask your Agent to deliver a report, web page or file, or generate media in Creative tools. Uploaded references are not automatically included.'); }
            for (const item of items.slice(state.page * 36, state.page * 36 + 36)) {
                const file = item.files[0], kind = item.types[0] || 'other';
                const displayTitle = item.source === 'media' && item.title === file.name ? (item.model || labels()[kind]) : item.title || file.name;
                const wrapper = node('div', null, 'artifacts-card-wrap');
                const card = button('', e => {
                    if (state.selecting) {
                        if (e.shiftKey && state.anchor) {
                            const keys = items.flatMap(i => i.files.map(f => ({ ...f, revision: i.revision }))), start = keys.findIndex(f => f.key === state.anchor), end = keys.findIndex(f => f.key === file.key);
                            if (start >= 0 && end >= 0) for (const f of keys.slice(Math.min(start, end), Math.max(start, end) + 1)) state.selected.set(f.key, f);
                        } else for (const f of item.files) { if (state.selected.has(f.key)) state.selected.delete(f.key); else state.selected.set(f.key, { ...f, revision: item.revision }); }
                        state.anchor = file.key; render(); return;
                    }
                    state.thumbnailController?.abort(); state.thumbnailQueue = []; viewer.open({ ...item, title: displayTitle });
                }, 'artifacts-card'); card.dataset.key = file.key; card.setAttribute('aria-label', displayTitle);
                if (state.selecting) { const choices = node('div', null, 'artifacts-file-choices'); for (const f of item.files) { const label = node('label'), checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = state.selected.has(f.key); checkbox.addEventListener('change', () => { if (checkbox.checked) state.selected.set(f.key, { ...f, revision: item.revision }); else state.selected.delete(f.key); render(); }); label.append(checkbox, node('span', f.name)); choices.append(label); } wrapper.append(choices); }
                else { const star = button(item.favorite ? '★' : '☆', () => { void manager.run('favorite', [{ ...file, revision: item.revision }], { favorite: !item.favorite }); }, 'artifacts-star'); star.setAttribute('aria-label', item.favorite ? tr('取消收藏', 'Unfavorite') : tr('收藏并独立保存', 'Favorite and save independently')); star.disabled = state.mutating || Boolean(item.trashedAt); wrapper.append(star); }
                wrapper.classList.toggle('is-selected', item.files.some(f => state.selected.has(f.key)));
                const cover = node('div', null, `artifacts-cover artifacts-cover-${kind}`), icon = node('i', null, 'fa-regular ' + (icons[kind] || icons.other));
                icon.className = 'fa-solid ' + (icons[kind] || icons.other); icon.setAttribute('aria-hidden', 'true'); cover.append(icon);
                cover.append(node('span', labels()[kind], 'artifacts-format'));
                if (item.files.length > 1) cover.append(node('span', `${item.files.length} ${tr('个文件', 'files')}`, 'artifacts-stack'));
                if (state.thumbs.has(file.key)) applyThumb(cover, state.thumbs.get(file.key));
                const content = node('div', null, 'artifacts-card-content'); content.append(node('h2', displayTitle));
                content.append(node('p', item.files.map(f => f.name).join(' · '), 'artifacts-filenames'));
                const meta = node('div', null, 'artifacts-card-meta'); meta.append(node('span', item.project?.name || tr('未关联项目', 'Unlinked project')));
                const date = node('time', item.createdAt ? new Date(item.createdAt).toLocaleDateString(window.PiI18n?.locale || 'zh-CN', { month: 'short', day: 'numeric' }) : tr('历史记录', 'Historical')); if (item.createdAt) date.dateTime = item.createdAt;
                meta.append(date); content.append(meta);
                content.append(node('span', item.independent ? tr('已独立保存', 'Independently saved') : tr('待保存 · 依赖来源', 'Unsaved · Source-linked'), 'artifacts-save-state'));
                card.append(cover, content); wrapper.append(card); grid.append(wrapper);
                if (kind === 'image' && !state.thumbs.has(file.key)) observer.observe(card);
            }
            previous.hidden = state.page === 0; next.hidden = (state.page + 1) * 36 >= items.length;
            pageCount.textContent = items.length > 36 ? `${state.page + 1} / ${Math.ceil(items.length / 36)}` : '';
            more.hidden = state.next == null && state.libraryNext == null; more.disabled = state.loading || state.mutating; refresh.disabled = state.loading || state.mutating;
            grid.setAttribute('aria-busy', String(state.loading));
        }
        async function loadSaved(reset) {
            const epoch = state.epoch;
            const params = new URLSearchParams(); if (!reset && state.libraryNext != null) { params.set('offset', state.libraryNext); params.set('revision', state.libraryRevision); }
            const data = await api('/api/pi/artifacts/library?' + params, { signal: state.controller?.signal });
            if (epoch !== state.epoch || !state.active) return;
            if (reset) state.savedItems.clear();
            for (const item of data.items || []) state.savedItems.set(item.key, item);
            state.savedSources = new Set(data.savedSources || [...state.savedItems.values()].map(i => i.sourceKey));
            state.collections = data.collections || [];
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
                if (data.partial) { notice.hidden = false; notice.textContent = tr('正在展示部分结果：个别来源不可读或达到扫描预算。可在项目筛选中选择项目单独发现，或稍后刷新；这不表示其他成果不存在。', 'Partial results: some sources could not be read or a scan budget was reached. Select a project to focus discovery or refresh later; other artifacts may still exist.'); }
                else if (state.next != null) { notice.hidden = false; notice.textContent = tr('已读取一批有效来源，可继续发现更多会话成果。搜索与类型筛选作用于已发现结果。', 'A batch of valid sources is ready. Discover more conversation artifacts below. Search and type filters apply to discovered results.'); }
            } catch (error) { if (epoch === state.epoch && error.name !== 'AbortError') { state.failed = true; notice.hidden = false; notice.textContent = error.message; } }
            finally { if (epoch === state.epoch) { state.loading = false; render(); void thumbnails(); } }
        }
        document.addEventListener('artifacts:mutation-state', e => { if (state.active) { if (e.detail?.stale) void load(true); else render(); } });
        collectionFilter.addEventListener('change', () => { state.collection = collectionFilter.value; state.page = 0; state.selected.clear(); render(); });
        search.addEventListener('input', () => { state.query = search.value; state.page = 0; render(); });
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
            state.scope = state.sessionId ? JSON.stringify([state.cwd, state.sessionId]) : '';
            // A returning page refreshes branch/history eligibility, not stale blobs.
            void load(true);
        }
        window.addEventListener('workspace:tabchanged', e => route(e.detail));
        window.addEventListener('workspace:artifacts-invalidated', () => { if (state.active) void load(true); });
        window.addEventListener('pagehide', () => { state.active = false; state.epoch++; state.controller?.abort(); viewer.close(); disposeThumbnails(); });
        route(window.PiWorkspaceRoute?.current());
    });
})();
