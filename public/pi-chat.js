document.addEventListener('DOMContentLoaded', () => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const attachments = window.PiAttachments;
    const LOCAL_COMMANDS = [
        { name: 'tree', description: translateUi("查看会话分支，选择从哪里继续"), source: 'web' },
        { name: 'trust', description: translateUi("管理当前项目的信任"), source: 'web' },
        { name: 'export', description: translateUi("打开当前线程的导出记录窗口"), source: 'web' },
        { name: 'import', description: translateUi("打开 Pi 会话导入窗口，选择文件与目标项目"), source: 'web' },
        { name: 'templates', description: translateUi("打开设置中的提示词模板入口"), source: 'web' },
        { name: 'copy', description: translateUi("复制最近一条 Agent 回复"), source: 'web' },
        { name: 'compact', description: translateUi("压缩上下文，可附加摘要要求"), source: 'web' },
        { name: 'quit', description: translateUi("退出当前 Pi runtime"), source: 'web' },
        { name: 'btw', description: translateUi("打开临时侧聊，可附加问题"), source: 'web' }
    ];
    const elements = {
        projectButton: $('pi-project-button'),
        projectName: $('pi-project-name'),
        projectPath: $('pi-project-path'),
        projectDialog: $('pi-project-dialog'),
        projectDialogClose: $('pi-project-dialog-close'),
        projectForm: $('pi-project-form'),
        projectInput: $('pi-project-input'),
        projectList: $('pi-project-list'),
        showHiddenProjects: $('pi-show-hidden-projects'),
        directoryList: $('pi-directory-list'),
        directoryCurrent: $('pi-directory-current'),
        directoryUp: $('pi-directory-up'),
        tokenDialog: $('pi-token-dialog'),
        tokenForm: $('pi-token-form'),
        tokenInput: $('pi-token-input'),
        sessionPane: $('pi-session-pane'),
        sessionList: $('pi-session-list'),
        sessionSearch: $('pi-session-search'),
        sessionSearchField: $('pi-session-search-field'),
        sessionSearchToggle: $('pi-session-search-toggle'),
        sessionHeadingTitle: $('pi-session-heading-title'),
        sessionFilters: $('pi-session-filters'),
        requestDialog: $('pi-request-dialog'),
        requestForm: $('pi-request-form'),
        requestFields: $('pi-request-fields'),
        requestTitle: $('pi-request-title'),
        requestSubmit: $('pi-request-submit'),
        requestCancel: $('pi-request-cancel'),
        sessionCount: $('pi-session-count'),
        refreshSessions: $('pi-refresh-sessions'),
        tempSession: $('pi-temp-session'),
        newSession: $('pi-new-session'),
        transcript: $('pi-transcript-content'),
        connectionBanner: $('pi-connection-banner'),
        connectionText: $('pi-connection-text'),
        modelSelect: $('pi-model-select'),
        modelRefresh: $('pi-model-refresh'),
        modelGuidance: $('pi-model-guidance'),
        modelGuidanceText: $('pi-model-guidance-text'),
        modelChoose: $('pi-model-choose'),
        modelSetup: $('pi-model-setup'),
        thinkingSelect: $('pi-thinking-select'),
        contextButton: $('pi-context-button'),
        contextPercent: $('pi-context-percent'),
        contextTokens: $('pi-context-tokens'),
        contextFill: $('pi-context-fill'),
        contextFraction: $('pi-context-fraction'),
        input: $('pi-input'),
        sendButton: $('pi-send-button'),
        stopButton: $('pi-stop-button'),
        deliveryMode: $('pi-delivery-mode'),
        fileInput: $('pi-file-input'),
        attachButton: $('pi-attach-button'),
        attachments: $('pi-attachments'),
        queue: $('pi-queue'),
        commandMenu: $('pi-command-menu'),
        composerStatus: $('pi-composer-status'),
        inspector: $('pi-inspector'),
        toggleInspector: $('pi-toggle-inspector'),
        closeInspector: $('pi-close-inspector'),
        toggleSessions: $('pi-toggle-sessions'),
        agentStateDot: $('pi-agent-state-dot'),
        agentState: $('pi-agent-state'),
        agentDetail: $('pi-agent-detail'),
        statInput: $('pi-stat-input'),
        statOutput: $('pi-stat-output'),
        statCache: $('pi-stat-cache'),
        statCost: $('pi-stat-cost'),
        autoCompact: $('pi-auto-compact'),
        autoRetry: $('pi-auto-retry'),
        compactButton: $('pi-compact-button'),
        compactionStatus: $('pi-compaction-status'),
        metaName: $('pi-meta-name'),
        metaId: $('pi-meta-id'),
        metaMessages: $('pi-meta-messages'),
        metaFile: $('pi-meta-file'),
        currentThreadMenu: $('pi-current-thread-menu'),
        toastRegion: $('pi-toast-region')
    };

    const transcriptScroll = new window.PiTranscriptScroll({
        viewport: $('pi-transcript'),
        content: elements.transcript,
        track: $('pi-transcript-track'),
        thumb: $('pi-transcript-thumb'),
        latest: $('pi-jump-latest')
    });

    const transcriptView = new window.PiTranscriptView({
        content: elements.transcript,
        controls: $('pi-transcript-modes'),
        scroll: transcriptScroll
    });

    const RECENT_PROJECTS_KEY = 'pi.web.recentProjects';
    const EXPANDED_PROJECTS_KEY = 'pi.web.expandedProjects';

    function readStoredArray(key) {
        try {
            const value = JSON.parse(localStorage.getItem(key) || '[]');
            return Array.isArray(value) ? value : [];
        } catch {
            return [];
        }
    }

    const state = {
        token: sessionStorage.getItem('pi.web.token') || '',
        projects: [],
        pinnedProjects: [],
        hiddenProjects: [],
        archiveEnabled: false,
        archiveRevision: -1,
        archivedProjects: new Set(),
        archivedSessions: new Set(),
        archiveRequests: new Set(),
        archiveProjectsOpen: false,
        archiveThreadsOpen: new Set(),
        includeArchived: false,
        visibilityRequests: new Set(),
        projectAliases: new Map(),
        projectIdentity: false,
        projectPreferenceRevision: 0,
        noticeRevision: 0,
        manualUnread: false,
        unreadRequests: new Set(),
        pinRequests: new Set(),
        activity: new Map(),
        replyNotices: new Map(),
        deferredSummary: new Map(),
        readRequests: new Set(),
        renderedCompletion: null,
        sessionFilter: 'all',
        recentSortSnapshot: new Map(),
        recentSessionsExpanded: false,
        recentlyOpened: new Map(),
        recentOpenSequence: 0,
        pendingUi: new Map(),
        shownUiId: null,
        activityFresh: false,
        activityEnabled: false,
        projectSessions: new Map(),
        loadingProjects: new Set(),
        expandedProjects: new Set(readStoredArray(EXPANDED_PROJECTS_KEY).filter(value => typeof value === 'string')),
        expandedThreadLists: new Set(),
        roots: [],
        defaultProject: null,
        directoryRequest: 0,
        cwd: '',
        sessions: [],
        session: null,
        socket: null,
        socketGeneration: 0,
        requests: new Map(),
        nextRequestId: 1,
        reconnectTimer: null,
        intentionalClose: false,
        connected: false,
        streaming: false,
        compacting: false,
        compactRequested: false,
        controlRequested: false,
        compaction: null,
        runtimeRevision: 0,
        model: null,
        models: [],
        modelCatalogSupported: false,
        modelRefreshOp: null,
        modelRefreshPending: false,
        modelRefreshError: '',
        modelAuthError: false,
        thinkingLevel: 'off',
        thinkingLevels: ['off'],
        stats: null,
        commands: [],
        lastAssistantText: '',
        attachmentFiles: [],
        attachmentEpoch: 0,
        attachmentReads: 0,
        attachmentQueue: Promise.resolve(),
        submittingDrafts: new Set(),
        uncertainDrafts: new Set(),
        liveMessage: null,
        toolRows: new Map(),
        currentDirectory: null,
        directoryParent: null,
        composerDrafts: new Map(),
        composerSessionKey: null
    };

    const shell = new window.PiShell({
        transcript: elements.transcript,
        context: () => ({ text: elements.input.value, enabled: state.userShell, queueModes: state.queueModes, connected: state.connected, streaming: state.streaming,
            blocked: state.compacting || state.compactRequested || state.controlRequested || state.controlsStopping || state.resourceRequested }),
        request: requestRpc, toast, reconcile: reconcileSession, scroll: scrollTranscript,
        changed: () => {
            state.shellBusy = shell.busy; setStreaming(state.streaming);
            if (state.connected && !state.shellBusy && !state.streaming && !state.compacting) {
                setConnection('connected', translateUi("Pi Agent 已连接")); setAgentState('connected', translateUi("空闲"), state.model?.id || 'Pi Agent');
            }
        }
    });

    let titleUiRevision = 0;
    let titleServerRevision = null;
    function sessionNamed(session, cwd, name) {
        titleUiRevision++;
        session.name = name;
        const listed = (state.projectSessions.get(cwd) || []).find(item => item.id === session.id);
        if (listed) listed.name = name;
        if (state.cwd === cwd && state.session?.id === session.id) {
            state.session.name = name; updateSessionMeta();
        }
        renderSessions();
    }
    const titleEditor = window.PiSessionTitles ? new window.PiSessionTitles({ apiFetch, saved: sessionNamed }) : null;
    const transfer = new window.PiSessionTransfer({
        apiFetch, toast, headers: () => apiHeaders(), projects: () => state.projects,
        refresh: async cwd => { state.projectPreferenceRevision++; await loadProjects(); await loadSessions(cwd); },
        open: async session => {
            if (session.cwd !== state.cwd) await selectProject(session.cwd);
            await openSession(session);
        }
    });

    const workflows = new window.PiSessionWorkflows({
        getContext: () => ({ cwd: state.cwd, session: state.session, connected: state.connected, model: state.model,
            busy: state.shellBusy || state.streaming || state.compacting || state.compactRequested || state.controlRequested || state.controlsStopping || state.pendingUi.size > 0,
            draftBusy: state.attachmentReads > 0 || state.submittingDrafts.has(state.composerSessionKey) }),
        apiFetch, toast,
        reconcile: reconcileSession,
        getDraft: () => {
            if (window.PiShell.parse(elements.input.value)) throw new Error(translateUi("Shell 命令不支持延迟发送，请在当前会话空闲时直接执行"));
            if (state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) throw new Error(translateUi("请等待附件读取或消息投递完成"));
            if (state.uncertainDrafts.has(state.composerSessionKey) && !window.confirm(translateUi("上次发送结果不确定。请先核对会话，重复预约可能重复执行任务。确认仍要预约此草稿？"))) throw new Error(translateUi("已取消预约，草稿已保留"));
            attachments.validateDraft(elements.input.value, state.attachmentFiles);
            return { text: elements.input.value, files: [...state.attachmentFiles], payload: attachments.payload(elements.input.value, state.attachmentFiles) };
        },
        consumeDraft: draft => {
            if (elements.input.value === draft.text && state.attachmentFiles.length === draft.files.length
                && state.attachmentFiles.every((file, index) => file === draft.files[index])) {
                state.uncertainDrafts.delete(state.composerSessionKey);
                elements.input.value = ''; clearAttachments(); autoResizeInput();
            }
        },
        openFork: async result => {
            await loadSessions(result.session.cwd);
            await openSession(result.session);
            if (result.draft) {
                elements.input.value = result.draft.message;
                state.attachmentFiles = result.draft.images.map((image, index) => ({ id: `fork-image-${index}`, kind: 'image', name: translateUi("图片 {0}", index + 1), data: image.data, mimeType: image.mimeType, preview: `data:${image.mimeType};base64,${image.data}` }));
                renderAttachments(); autoResizeInput(); elements.input.focus();
            }
        }
    });

    const sideChat = new window.PiSideChat({
        context: () => ({ cwd: state.cwd, session: state.session, token: state.token, connected: state.connected,
            busy: state.streaming || state.compacting || state.compactRequested, waiting: state.pendingUi.size > 0 }),
        prepare: options => requestRpc('prepare_side_chat', options, 65000),
        renderMarkdown, finalReplyIndices, copyText: copyTextToClipboard, toast,
        focusMain: () => {
            elements.inspector.classList.remove('open');
            if (state.pendingUi.size) openPendingRequest();
            else elements.input.focus();
        },
        insertDraft: text => {
            if (!state.connected || state.attachmentReads) throw new Error(translateUi("请先连接主会话并等待附件读取完成"));
            const draft = `${elements.input.value}${elements.input.value ? '\n\n' : ''}${text}`;
            attachments.validateDraft(draft, state.attachmentFiles);
            elements.input.value = draft; autoResizeInput();
            if (innerWidth <= 900) elements.inspector.classList.remove('open');
            elements.input.focus();
        }
    });

    const mainQuotes = document.createElement('div'); mainQuotes.className = 'pi-composer-quotes';
    elements.attachments.before(mainQuotes);
    const selectionActions = new window.PiSelectionActions({
        context: () => ({ connected: state.connected, key: JSON.stringify([state.cwd, state.session?.id, state.socketGeneration]) }),
        sideEnabled: () => sideChat.enabled,
        addMain: quote => {
            if (state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) throw new Error(translateUi('请等待附件读取或消息投递完成'));
            const file = { ...quote, kind: 'quote', id: attachments.id() };
            const files = [...state.attachmentFiles, file];
            attachments.validateDraft(elements.input.value, files);
            state.attachmentFiles = files; renderAttachments(); autoResizeInput();
            if (innerWidth <= 900) elements.inspector.classList.remove('open');
            elements.input.focus();
        },
        addSide: quote => sideChat.open({ quote }), toast
    });

    const turnEdits = new window.PiTurnEdits({
        transcript: elements.transcript, showPane: mode => sideChat.showPane(mode), copy: copyTextToClipboard, notify: toast,
        api: apiFetch, context: () => ({ cwd: state.cwd, key: JSON.stringify([state.cwd, state.session?.id]), generation: state.socketGeneration })
    });

    const nativeControls = new window.PiRuntimeControls({
        connected: () => state.connected,
        changed: () => { state.controlsStopping = Boolean(nativeControls.value?.stopping); editorSuggestions.apply(nativeControls.value); setStreaming(state.streaming); },
        toast, copy: copyTextToClipboard,
        take: stop => takeRuntimeQueue(stop),
        ack: async recoveryId => {
            const generation = state.socketGeneration;
            const value = await requestRpc('ack_recovery', { recoveryId });
            return generation === state.socketGeneration ? value : null;
        },
        append: text => {
            if (!state.connected || state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) throw new Error(translateUi("请等待连接、附件读取或消息投递完成"));
            const draft = `${elements.input.value}${elements.input.value ? '\n\n' : ''}${text}`;
            attachments.validateDraft(draft, state.attachmentFiles);
            elements.input.value = draft; autoResizeInput();
        }
    });

    const editorSuggestions = new window.PiEditorSuggestions({
        connected: () => state.connected, text: () => elements.input.value, toast,
        canAutofill: () => state.connected && elements.input.value === '' && !state.attachmentFiles.length && !state.attachmentReads && !state.submittingDrafts.has(state.composerSessionKey),
        ack: (runtimeId, draftId) => requestRpc('ack_extension_draft', { runtimeId, draftId }),
        accept: (text, mode) => {
            if (!state.connected || state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) { toast(translateUi("请等待附件读取或消息提交结束"), 'info'); return false; }
            const draft = mode === 'replace' ? text : elements.input.value + (elements.input.value ? '\n\n' : '') + text;
            try { attachments.validateDraft(draft, state.attachmentFiles); }
            catch (e) { toast(e.message, 'error'); return false; }
            elements.input.value = draft; autoResizeInput(); return true;
        }
    });

    const historyView = new window.PiHistoryView({
        context: () => ({ key: JSON.stringify([state.cwd, state.session?.id]), generation: state.socketGeneration, session: state.session, connected: state.connected,
            busy: state.treeBusy || state.streaming || state.shellBusy || state.compacting || state.compactRequested || state.controlRequested || state.resourceRequested || state.pendingUi.size > 0 || state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey) }),
        request: (type, input, timeout = 45000) => requestRpc(type, input, timeout), copy: copyTextToClipboard, toast, renderMarkdown,
        navigationBusy: busy => { if (state.treeBusy !== busy) { state.treeBusy = busy; setStreaming(state.streaming); } },
        useDraft: (draft, onlyEmpty) => {
            if (!state.connected || state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey) || state.streaming || state.compacting) {
                if (onlyEmpty) return false;
                throw new Error(translateUi("请等待连接、任务和附件读取完成后追加"));
            }
            if (onlyEmpty && (elements.input.value || state.attachmentFiles.length)) return false;
            const images = draft.images.map((image, i) => ({ id: `tree-${Date.now()}-${i}`, kind: 'image', name: translateUi("原问题图片 {0}", i + 1), data: image.data, mimeType: image.mimeType, preview: `data:${image.mimeType};base64,${image.data}` }));
            const text = `${elements.input.value}${elements.input.value && draft.message ? '\n\n' : ''}${draft.message}`;
            const files = [...state.attachmentFiles, ...images];
            attachments.validateDraft(text, files); elements.input.value = text; state.attachmentFiles = files; renderAttachments(); autoResizeInput();
            return true;
        },
        showPane: mode => sideChat.showPane(mode)
    });

    const conversationSearch = new window.PiSessionSearch({
        api: apiFetch, cwd: () => state.cwd, toast,
        open: async (row, q) => {
            const generation = state.socketGeneration;
            const data = await apiFetch('/api/pi/sessions?cwd=' + encodeURIComponent(row.cwd));
            if (generation !== state.socketGeneration) return;
            const session = data.sessions.find(s => s.id === row.sessionId);
            if (!session) throw new Error(translateUi("线程已被移动或删除，请重新搜索"));
            if (state.session?.ephemeral && !confirm(translateUi("打开搜索结果会结束当前临时会话，是否继续？"))) return;
            if (row.cwd !== state.cwd) await selectProject(row.cwd);
            if (state.cwd !== row.cwd) return;
            await openSession(session);
            if (state.session?.id !== row.sessionId || state.cwd !== row.cwd) return;
            historyView.sync(); historyView.query.value = q; historyView.scope.value = 'all';
            historyView.open(); historyView.queueSearch(0);
            await historyView.openEntry(row.entryId, Math.max(0, row.matchOffset - 1000), 'body');
        }
    });

    const composer = new window.PiComposerTools({
        context: () => ({ cwd: state.cwd, key: JSON.stringify([state.composerSessionKey, state.socketGeneration]), connected: state.connected }),
        api: apiFetch, toast, changed: autoResizeInput, reload: reloadResources,
        locals: () => LOCAL_COMMANDS.filter(c => c.name !== 'btw' || sideChat.enabled).map(c =>
            c.name === 'tree' && !historyView.tree.enabled ? { ...c, available: false, description: translateUi("当前后端尚未启用会话树") } :
            c.name === 'trust' && !state.nativeSettings ? { ...c, available: false, description: translateUi("当前后端尚未启用项目信任设置") } :
            ['import', 'export'].includes(c.name) && !transfer.enabled
                ? { ...c, available: false, description: translateUi("当前后端尚未启用会话导入与导出，请启用后刷新页面") } : c),
        commands: commands => { state.commands = commands; }
    });

    if (window.marked) {
        window.marked.setOptions({ gfm: true, breaks: true });
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function renderMarkdown(text) {
        const source = String(text || '');
        if (!window.marked || !window.DOMPurify) return `<p>${escapeHtml(source).replace(/\n/g, '<br>')}</p>`;
        const base = /^[a-z]:[\\/]/i.test(state.cwd || '') ? state.cwd.replace(/\\/g, '/') + '/' : '';
        return window.PiFileViewer.markdown(source, base);
    }

    function apiHeaders(extra = {}) {
        return {
            ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}),
            ...extra
        };
    }

    async function apiFetch(url, options = {}) {
        const response = await (window.WorkspaceAccess?.fetch || fetch)(url, {
            ...options,
            headers: apiHeaders(options.headers || {})
        });
        let data = null;
        try {
            data = await response.json();
        } catch {}
        if (response.status === 401) {
            showTokenDialog();
            throw new Error(translateUi("需要 Pi Web 访问令牌"));
        }
        if (!response.ok) throw new Error(translateUi(data?.error || `HTTP ${response.status}`));
        return data;
    }

    function toast(message, type = 'info', timeout = 4200) {
        message = translateUi(message);
        const item = document.createElement('div');
        item.className = `pi-toast ${type}`;
        item.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i><span></span>`;
        item.querySelector('span').textContent = message;
        elements.toastRegion.appendChild(item);
        requestAnimationFrame(() => item.classList.add('visible'));
        setTimeout(() => {
            item.classList.remove('visible');
            setTimeout(() => item.remove(), 220);
        }, timeout);
    }

    function setConnection(kind, text) {
        elements.connectionBanner.dataset.state = kind;
        elements.connectionText.textContent = text;
    }

    function setAgentState(kind, title, detail) {
        elements.agentStateDot.dataset.state = kind;
        elements.agentState.textContent = title;
        elements.agentDetail.textContent = detail;
    }

    function formatTokens(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return '--';
        if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
        if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
        return String(n);
    }

    function formatDate(value) {
        if (!value) return '';
        const date = new Date(value);
        const now = new Date();
        if (date.toDateString() === now.toDateString()) {
            return date.toLocaleTimeString(globalThis.PiI18n?.locale || 'zh-CN', { hour: '2-digit', minute: '2-digit' });
        }
        return date.toLocaleDateString(globalThis.PiI18n?.locale || 'zh-CN', { month: '2-digit', day: '2-digit' });
    }

    function truncate(value, length = 72) {
        const text = String(value || '').replace(/\s+/g, ' ').trim();
        return text.length > length ? `${text.slice(0, length)}...` : text;
    }

    function showTokenDialog() {
        if (window.WorkspaceAccess?.requireLogin()) return;
        elements.tokenDialog.classList.remove('hidden');
        setTimeout(() => elements.tokenInput.focus(), 0);
    }

    const taskResults = window.PiTaskResults?.create({ root: document.getElementById('pi-task-results'), fetch: apiFetch,
        scope: () => state.session && !state.session.ephemeral ? { cwd: state.cwd, id: state.session.id, generation: state.socketGeneration,
            busy: !state.connected || state.streaming || state.compacting || state.shellBusy || state.pendingUi.size > 0 } : null,
        link: appendAgentThreadLink, error: message => toast(message, 'error') });
    let accessBootstrapped = false;
    async function bootstrap() {
        await window.WorkspaceAccess?.ready;
        if (window.WorkspaceAccess?.supported) {
            state.token = '';
            if (!window.WorkspaceAccess.authenticated) return;
        }
        elements.projectButton.disabled = true;
        setConnection('connecting', translateUi("正在连接 Pi Agent"));
        try {
            const status = await apiFetch('/api/pi/status');
            accessBootstrapped = true;
            state.modelCatalogSupported = status.modelCatalog === true;
            taskResults?.setEnabled(status.agentTaskResults === true);
            state.runtimeConfiguration = status.runtimeConfiguration === true;
            conversationSearch.setEnabled(status.sessionSearch === true);
            state.extensionDrafts = status.extensionDrafts === true;
            state.userShell = status.userShell === true;
            state.queueModes = status.queueModes === true;
            if (titleEditor) { titleEditor.enabled = status.sessionTitles === true; titleEditor.modelSelection = status.sessionTitleModels === true; }
            transfer.setEnabled(status.sessionTransfer === true);
            historyView.setEnabled(status.historySearch === true);
            historyView.setCapabilities(status);
            turnEdits.viewer.setEnabled(status.fileViewer === true);
            composer.setEnabled(status.composerTools === true);
            state.composerTools = status.composerTools === true;
            state.nativeSettings = status.nativeSettings === true;
            state.nativeResources = status.nativeResources === true;
            extensionAssistant.setEnabled(status.extensionAssistant === true);
            state.systemPrompts = status.systemPrompts === true;
            nativeContext.sync();
            state.roots = status.projectRoots || [];
            state.defaultProject = status.defaultProject || state.roots[0] || null;
            state.projectIdentity = status.projectIdentity === true;
            state.manualUnread = status.manualUnread === true;
            state.archiveEnabled = status.archives === true;
            conversationSearch.setArchivesEnabled(state.archiveEnabled);
            workflows.setEnabled(status.sessionWorkflows === true);
            sideChat.setEnabled(status.sideChat === true, status.sideChatContext === true, status.sideChatRetention === true, status.sideChatTools === true);
            window.PiReplyTts.setEnabled(status.replyTts === true);
            elements.tokenDialog.classList.add('hidden');
            await loadProjects();
            state.activityEnabled = true;
            void refreshActivity();
            const savedProject = localStorage.getItem('pi.web.cwd');
            const preferred = state.projectAliases.get(savedProject) || savedProject;
            const visibleProjects = orderedProjects();
            const project = visibleProjects.find(item => item.cwd === preferred)
                || visibleProjects[0];
            if (project) await selectProject(project.cwd, { restoreSession: true });
            else openProjectDialog();
        } catch (error) {
            if (!elements.tokenDialog.classList.contains('hidden')) return;
            setConnection('error', error.message);
            toast(error.message, 'error');
        } finally {
            elements.projectButton.disabled = false;
        }
    }

    async function loadProjects() {
        const revision = state.projectPreferenceRevision;
        const recentProjects = readStoredArray(RECENT_PROJECTS_KEY)
            .filter(project => project && typeof project.cwd === 'string');
        const recent = [...new Set([...recentProjects.map(item => item.cwd), ...state.projects.map(item => item.cwd),
            ...state.expandedProjects, localStorage.getItem('pi.web.cwd')].filter(Boolean))].slice(0, 64);
        const query = state.projectIdentity ? `?recent=${encodeURIComponent(JSON.stringify(recent))}` : '';
        const data = await apiFetch(`/api/pi/projects${query}`);
        if (revision !== state.projectPreferenceRevision || state.visibilityRequests.size || state.pinRequests.size) return;
        for (const { input, cwd } of data.projectAliases || []) {
            state.projectAliases.set(input, cwd);
            if (cwd && cwd !== input) {
                const saved = localStorage.getItem(`pi.web.session:${input}`);
                if (saved && !localStorage.getItem(`pi.web.session:${cwd}`)) localStorage.setItem(`pi.web.session:${cwd}`, saved);
            }
        }
        const canonical = cwd => state.projectAliases.has(cwd) ? state.projectAliases.get(cwd) : cwd;
        state.expandedProjects = new Set([...state.expandedProjects].map(canonical).filter(Boolean));
        const serverProjects = data.projects || [];
        state.pinnedProjects = data.pinnedProjects || [];
        applyHiddenProjects(data.hiddenProjects || []);
        applyArchives(data.archives);
        const projectsByCwd = new Map(serverProjects.map(project => [project.cwd, project]));
        const orderedCwds = [...new Set([
            ...state.projects.map(project => canonical(project.cwd)),
            ...recentProjects.map(project => canonical(project.cwd)),
            ...serverProjects.map(project => project.cwd)
        ].filter(Boolean))];
        state.projects = orderedCwds.map(cwd => {
            const serverProject = projectsByCwd.get(cwd);
            const recentProject = recentProjects.find(project => canonical(project.cwd) === cwd);
            return serverProject || {
                cwd,
                name: recentProject?.name || getProjectName(cwd),
                sessionCount: 0,
                modified: recentProject?.modified || null
            };
        });
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(state.projects
            .filter(project => !state.hiddenProjects.includes(project.cwd)).slice(0, 24)
            .map(({ cwd, name, modified }) => ({ cwd, name, modified }))));
        state.roots = data.roots || state.roots;
        renderProjects();
        renderSessions();
        await Promise.allSettled(state.projects
            .filter(project => state.expandedProjects.has(project.cwd) && !state.projectSessions.has(project.cwd))
            .map(project => loadSessions(project.cwd)));
    }

    function getProjectName(cwd) {
        return String(cwd || '').split('/').filter(Boolean).pop() || cwd || translateUi("项目");
    }

    function rememberProject(cwd) {
        const existing = state.projects.find(project => project.cwd === cwd);
        const project = existing || { cwd, name: getProjectName(cwd), sessionCount: 0, modified: null };
        if (!existing) state.projects.push(project);
        const recent = state.projects.filter(item => !state.hiddenProjects.includes(item.cwd)).slice(0, 24).map(item => ({
            cwd: item.cwd,
            name: item.name || getProjectName(item.cwd),
            modified: item.modified || null
        }));
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
    }

    function saveExpandedProjects() {
        localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify([...state.expandedProjects]));
    }

    function orderedProjects(includeHidden = false) {
        const pins = new Map(state.pinnedProjects.map((cwd, index) => [cwd, index]));
        return state.projects.filter(project => includeHidden || !state.hiddenProjects.includes(state.projectAliases.get(project.cwd) || project.cwd))
            .sort((a, b) => (pins.get(a.cwd) ?? pins.size) - (pins.get(b.cwd) ?? pins.size));
    }

    function isThreadArchived(cwd, id) {
        return state.archivedProjects.has(cwd) || state.archivedSessions.has(activityKey(cwd, id));
    }

    function applyArchives(data) {
        if (!data || !Number.isSafeInteger(data.revision) || data.revision <= state.archiveRevision) return false;
        state.archiveRevision = data.revision;
        state.archivedProjects = new Set(data.projects || []);
        state.archivedSessions = new Set((data.sessions || []).map(item => activityKey(item.cwd, item.sessionId)));
        for (const cwd of state.archivedProjects) {
            if (!state.projects.some(project => project.cwd === cwd)) state.projects.push({ cwd, name: getProjectName(cwd), sessionCount: 0 });
        }
        return true;
    }

    async function setArchive(cwd, session, archived) {
        const key = activityKey(cwd, session?.id || '');
        if (!state.archiveEnabled || session?.ephemeral || state.archiveRequests.has(key)) return;
        state.archiveRequests.add(key);
        try {
            const url = session ? `/api/pi/sessions/${encodeURIComponent(session.id)}/archive` : '/api/pi/projects/archive';
            const data = await apiFetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd, archived }) });
            if (!data.archives || !Number.isSafeInteger(data.archives.revision)) throw new Error(translateUi('归档状态未确认，请刷新核对'));
            applyArchives(data.archives);
            renderProjects();
            renderSessions();
            const effective = session ? state.archivedSessions.has(activityKey(cwd, session.id)) : state.archivedProjects.has(cwd);
            toast(effective ? translateUi('已归档') : translateUi('已恢复'), 'success');
            const summary = session
                ? elements.sessionList.querySelector(`[data-archive-kind="threads"][data-cwd="${CSS.escape(cwd)}"] > summary`)
                : elements.sessionList.querySelector('[data-archive-kind="projects"] > summary');
            if (effective) summary?.focus({ preventScroll: true });
        } finally { state.archiveRequests.delete(key); }
    }

    function applyHiddenProjects(hidden) {
        state.hiddenProjects = hidden;
        const recent = readStoredArray(RECENT_PROJECTS_KEY).filter(project => !hidden.includes(state.projectAliases.get(project?.cwd) || project?.cwd));
        localStorage.setItem(RECENT_PROJECTS_KEY, JSON.stringify(recent));
        for (const cwd of hidden) state.expandedProjects.delete(cwd);
        saveExpandedProjects();
        if (hidden.includes(state.projectAliases.get(state.cwd) || state.cwd) && !state.session) {
            state.cwd = '';
            state.sessions = [];
            localStorage.removeItem('pi.web.cwd');
            elements.projectName.textContent = translateUi("选择项目");
            elements.projectPath.textContent = '';
            elements.projectInput.value = '';
            clearSessionView();
            setConnection('idle', translateUi("选择项目开始工作"));
        }
    }

    async function removeEmptyProject(cwd) {
        if (state.visibilityRequests.has(cwd)) return;
        state.visibilityRequests.add(cwd);
        state.projectPreferenceRevision++;
        try {
            const data = await apiFetch('/api/pi/projects/visibility', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, hidden: true })
            });
            const resolved = data.cwd || state.projectAliases.get(cwd) || cwd;
            if (!Array.isArray(data.hiddenProjects) || !data.hiddenProjects.includes(resolved)) {
                throw new Error(translateUi("服务端未确认项目已移出，请刷新后重试"));
            }
            state.projectAliases.set(cwd, resolved);
            state.pinnedProjects = data.pinnedProjects || [];
            applyHiddenProjects(data.hiddenProjects);
            state.projectSessions.delete(cwd);
            renderProjects();
            renderSessions();
            toast(translateUi("项目已从列表移除，目录和文件保留"), 'success');
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            state.visibilityRequests.delete(cwd);
            state.projectPreferenceRevision++;
        }
    }

    async function toggleProjectPin(cwd) {
        if (state.pinRequests.has(cwd)) return;
        state.pinRequests.add(cwd);
        state.projectPreferenceRevision++;
        renderSessions();
        try {
            const data = await apiFetch('/api/pi/projects/pin', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, pinned: !state.pinnedProjects.includes(cwd) })
            });
            state.pinnedProjects = data.pinnedProjects;
            if (data.hiddenProjects) applyHiddenProjects(data.hiddenProjects);
            renderProjects();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            state.pinRequests.delete(cwd);
            state.projectPreferenceRevision++;
            renderSessions();
            elements.sessionList.querySelector(`[data-project-cwd="${CSS.escape(cwd)}"] [data-project-action="pin"]`)?.focus();
        }
    }

    function activityKey(cwd, id) { return JSON.stringify([cwd, id]); }

    const ACTIVITY_LABELS = {
        running: [translateUi("处理中"), 'fa-spinner fa-spin'], tool: [translateUi("工具执行"), 'fa-screwdriver-wrench'],
        compacting: [translateUi("压缩中"), 'fa-compress'], retrying: [translateUi("重试中"), 'fa-rotate-right'],
        idle: [translateUi("空闲"), 'fa-circle-check'], error: [translateUi("失败"), 'fa-circle-exclamation'],
        stopped: [translateUi("已停止"), 'fa-stop'], waiting: [translateUi("等待确认"), 'fa-hand'], inactive: [translateUi("未运行"), 'fa-circle'], unknown: [translateUi("状态未知"), 'fa-question-circle']
    };

    // Each thread has one row; section placement is only a reversible DOM projection.
    function restoreWorkSessionRows() {
        elements.sessionList.querySelectorAll('.pi-work-session').forEach(row => {
            row._piWorkOrigin?.replaceWith(row);
            row._piWorkOrigin = null;
            row.classList.remove('pi-work-session', 'pi-recent-session');
        });
    }

    function workSessionSection(kind, label) {
        let section = elements.sessionList.querySelector(`[data-work-section="${kind}"]`);
        if (!section) {
            section = document.createElement('section');
            section.className = `pi-work-sessions${kind === 'recent' ? ' pi-recent-sessions' : ''}`;
            section.dataset.workSection = kind;
            section.setAttribute('aria-label', label);
            const heading = document.createElement('h3');
            heading.textContent = label;
            const count = document.createElement('span');
            count.className = 'pi-work-session-count';
            heading.appendChild(count);
            const rows = document.createElement('div');
            rows.className = 'pi-work-session-rows';
            rows.id = `pi-work-${kind}-rows`;
            section.append(heading, rows);
            if (kind === 'recent') {
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = 'pi-thread-more';
                toggle.dataset.workAction = 'toggle-recent';
                toggle.setAttribute('aria-controls', rows.id);
                section.appendChild(toggle);
            }
            elements.sessionList.appendChild(section);
        }
        return section;
    }

    function renderWorkSessions() {
        if (state.sessionFilter !== 'work' || !state.activityFresh) {
            elements.sessionList.querySelectorAll('[data-work-section]').forEach(section => section.remove());
            return 0;
        }
        const rows = [...elements.sessionList.querySelectorAll('.pi-project-group [data-session-id]')];
        const recent = rows.filter(row => row.dataset.workStage === 'recent')
            .map(row => {
                const key = activityKey(row.dataset.cwd, row.dataset.sessionId);
                // Freeze visit priority and timestamps for this visit to the work view.
                // Selecting a row must not move a different thread under the pointer.
                let rank = state.recentSortSnapshot.get(key);
                if (rank?.modified === undefined) {
                    const session = state.projectSessions.get(row.dataset.cwd)?.find(item => item.id === row.dataset.sessionId);
                    rank = { opened: rank?.opened || 0, modified: Date.parse(session?.modified) || 0 };
                    state.recentSortSnapshot.set(key, rank);
                }
                return { row, key, ...rank };
            })
            .sort((a, b) => b.opened - a.opened || b.modified - a.modified || a.key.localeCompare(b.key));
        const recentLimit = state.recentSessionsExpanded ? 12 : 6;
        const sections = [
            ['attention', translateUi("需处理"), rows.filter(row => row.dataset.workStage === 'attention')],
            ['running', translateUi("处理中"), rows.filter(row => row.dataset.workStage === 'running')],
            ['unknown', translateUi("状态待更新"), rows.filter(row => row.dataset.workStage === 'unknown')],
            ['recent', translateUi("最近会话"), recent.slice(0, recentLimit).map(item => item.row)],
            ['archive', translateUi('已归档'), rows.filter(row => row.dataset.workStage === 'archive')]
        ];
        let count = 0;
        for (const [kind, label, items] of sections) {
            const section = workSessionSection(kind, label);
            section.hidden = !items.length;
            section.querySelector('.pi-work-session-count').textContent = String(items.length);
            const container = section.querySelector('.pi-work-session-rows');
            for (const row of items) {
                const origin = document.createComment('work session position');
                row.before(origin);
                row._piWorkOrigin = origin;
                row.classList.add('pi-work-session');
                row.classList.toggle('pi-recent-session', kind === 'recent');
                row.hidden = false;
                container.appendChild(row);
            }
            if (kind === 'recent') {
                const toggle = section.querySelector('[data-work-action]');
                toggle.hidden = recent.length <= 6 && !state.recentSessionsExpanded;
                toggle.setAttribute('aria-expanded', String(state.recentSessionsExpanded));
                toggle.textContent = state.recentSessionsExpanded ? translateUi("收起（显示 6 条）") : translateUi("展开更多（{0} 条）", Math.min(recent.length, 12));
            }
            count += items.length;
        }
        return count;
    }

    function renderActivityBadges() {
        const focused = elements.sessionList.contains(document.activeElement) ? document.activeElement : null;
        const scrollTop = elements.sessionList.scrollTop;
        restoreWorkSessionRows();
        elements.sessionList.querySelectorAll('[data-session-id]').forEach(row => {
            const key = activityKey(row.dataset.cwd, row.dataset.sessionId);
            const activity = state.activityFresh ? state.activity.get(key) : null;
            let phase = state.activityFresh ? activity?.phase || 'inactive' : 'unknown';
            if (row.classList.contains('ephemeral')) {
                phase = !state.connected ? 'unknown' : state.pendingUi.size ? 'waiting' : state.shellBusy ? 'tool' : state.compacting ? 'compacting' : state.streaming ? 'running' : 'idle';
            }
            if (!ACTIVITY_LABELS[phase]) phase = 'unknown';
            const [label, icon] = ACTIVITY_LABELS[phase];
            const badge = row.querySelector('.pi-session-activity');
            if (badge.dataset.phase !== phase) {
                badge.dataset.phase = phase;
                badge.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span>`;
            }
            badge.title = phase === 'inactive' ? translateUi("本工作台没有此会话的运行实例；不代表外部终端状态")
                : phase === 'idle' ? translateUi("运行实例仍保留，可使用 /quit 退出") : label;
            const notice = state.replyNotices.get(key);
            const unread = Boolean(notice);
            const unreadBadge = row.querySelector('.pi-session-unread');
            unreadBadge.hidden = !unread;
            unreadBadge.lastChild.textContent = notice?.manual ? translateUi(" 未读") : translateUi(" 新回复");
            const deferred = state.deferredSummary.get(key);
            const delayedBadge = row.querySelector('.pi-session-deferred');
            delayedBadge.hidden = !deferred?.count;
            delayedBadge.textContent = deferred?.count ? translateUi("{0} 条待发送{1}", deferred.count, deferred.attention ? translateUi(" · 需确认") : '') : '';
            const attention = unread || deferred?.attention || ['waiting', 'error'].includes(phase);
            const busy = Boolean(activity?.busy) || ['running', 'tool', 'compacting', 'retrying'].includes(phase);
            row.dataset.workStage = attention ? 'attention' : busy ? 'running' : phase === 'unknown' ? 'unknown'
                : !row.classList.contains('ephemeral') && !isThreadArchived(row.dataset.cwd, row.dataset.sessionId) ? 'recent'
                    : state.includeArchived && elements.sessionSearch.value.trim() && !row.classList.contains('ephemeral') ? 'archive' : '';
            row.hidden = state.sessionFilter === 'work' && state.activityFresh;
        });
        elements.sessionList.querySelectorAll('[data-project-cwd]').forEach(group => {
            const runtimes = [...state.activity.values()].filter(item => item.cwd === group.dataset.projectCwd);
            const busy = runtimes.filter(item => item.busy && item.phase !== 'waiting').length;
            const waiting = runtimes.filter(item => item.phase === 'waiting').length;
            const failed = runtimes.filter(item => item.phase === 'error').length;
            const unread = [...state.replyNotices.values()].filter(item => item.cwd === group.dataset.projectCwd).length;
            const delayedAttention = [...state.deferredSummary.values()].filter(item => item.cwd === group.dataset.projectCwd && item.attention).length;
            const badge = group.querySelector('.pi-project-activity');
            badge.textContent = !state.activityFresh ? translateUi("状态未知") : [delayedAttention && translateUi("{0} 个延迟待确认", delayedAttention), waiting && translateUi("{0} 个待确认", waiting), unread && translateUi("{0} 个未读", unread), busy && translateUi("{0} 个处理中", busy), failed && translateUi("{0} 个失败", failed)].filter(Boolean).join(' · ');
            badge.dataset.phase = !state.activityFresh ? 'unknown' : waiting ? 'waiting' : unread ? 'unread' : busy ? 'running' : failed ? 'error' : 'idle';
            badge.hidden = !badge.textContent;
            group.hidden = state.sessionFilter === 'work' && state.activityFresh;
        });
        let empty = elements.sessionList.querySelector('.pi-filter-empty');
        if (!empty) {
            empty = document.createElement('div');
            empty.className = 'pi-list-state pi-filter-empty';
            elements.sessionList.appendChild(empty);
        }
        const count = renderWorkSessions();
        const work = state.sessionFilter === 'work';
        empty.textContent = !state.activityFresh ? (state.activityEnabled ? translateUi("工作状态暂不可用，显示已加载会话") : translateUi("正在读取工作状态"))
            : state.loadingProjects.size ? translateUi("正在读取会话") : elements.sessionSearch.value.trim() ? translateUi("没有匹配的工作会话") : translateUi("暂无需处理、处理中或最近会话");
        empty.hidden = !work || state.activityFresh && count > 0;
        empty.classList.toggle('pi-work-notice', work);
        elements.sessionList.scrollTop = scrollTop;
        if (focused?.isConnected && focused !== document.activeElement) focused.focus({ preventScroll: true });
    }

    let activityInFlight = false;
    async function refreshActivity() {
        if (!state.activityEnabled || document.hidden || activityInFlight) return;
        activityInFlight = true;
        const projectRevision = state.projectPreferenceRevision;
        const noticeRevision = state.noticeRevision;
        try {
            const data = await apiFetch('/api/pi/activity', { signal: AbortSignal.timeout(8000) });
            void taskResults?.refresh();
            if (document.hidden) return;
            if (data.titleRevision && data.titleRevision !== titleServerRevision) {
                const revision = titleUiRevision;
                const results = await Promise.allSettled([...state.projectSessions.keys()].map(cwd => loadSessions(cwd)));
                if (revision === titleUiRevision && results.every(result => result.status === 'fulfilled')) {
                    titleServerRevision = data.titleRevision;
                    const current = (state.projectSessions.get(state.cwd) || []).find(item => item.id === state.session?.id);
                    if (current && state.session) { state.session.name = current.name; updateSessionMeta(); }
                }
            }
            const archivesChanged = applyArchives(data.archives);
            state.activity = new Map((data.runtimes || []).map(item => [activityKey(item.cwd, item.sessionId), item]));
            state.activityFresh = true;
            void workflows.refresh().catch(() => {});
            const currentPreferences = projectRevision === state.projectPreferenceRevision
                && !state.visibilityRequests.size && !state.pinRequests.size;
            if (currentPreferences && data.hiddenProjects
                && JSON.stringify(data.hiddenProjects) !== JSON.stringify(state.hiddenProjects)) {
                applyHiddenProjects(data.hiddenProjects);
                renderProjects();
                renderSessions();
            }
            if (noticeRevision === state.noticeRevision && !state.unreadRequests.size && !state.readRequests.size) {
                state.replyNotices = new Map((data.replyNotices || []).map(item => [activityKey(item.cwd, item.sessionId), item]));
            }
            state.deferredSummary = new Map((data.deferred?.sessions || []).map(item => [activityKey(item.cwd, item.sessionId), item]));
            workflows.setStoreError(data.deferred?.error);
            const incomingCwds = [...new Set([...(data.runtimes || []).map(item => item.cwd), ...(data.replyNotices || []).map(item => item.cwd), ...(data.deferred?.sessions || []).map(item => item.cwd)])];
            let addedProject = false;
            for (const cwd of incomingCwds) {
                if (!state.projects.some(project => project.cwd === cwd)) {
                    state.projects.push({ cwd, name: getProjectName(cwd), sessionCount: 0 });
                    addedProject = true;
                }
            }
            if (addedProject || archivesChanged) { renderProjects(); renderSessions(); }
            if (currentPreferences && JSON.stringify(data.pinnedProjects) !== JSON.stringify(state.pinnedProjects)) {
                state.pinnedProjects = data.pinnedProjects || [];
                for (const cwd of state.pinnedProjects) {
                    if (!state.projects.some(project => project.cwd === cwd)) {
                        state.projects.push({ cwd, name: getProjectName(cwd), sessionCount: 0 });
                    }
                }
                renderProjects();
                renderSessions();
            }
            if (state.sessionFilter !== 'all') void loadFilteredProjects();
            void acknowledgeRenderedReply();
        } catch {
            state.activityFresh = false;
        } finally {
            activityInFlight = false;
            renderActivityBadges();
        }
    }

    function renderProjects() {
        if (!state.projects.length) {
            elements.projectList.innerHTML = `<div class="pi-list-state">${translateUi("暂无最近项目")}</div>`;
            return;
        }
        elements.projectList.innerHTML = orderedProjects(elements.showHiddenProjects.checked).map(project => `
            <button type="button" class="pi-project-row" data-cwd="${escapeHtml(project.cwd)}">
                <span class="pi-project-row-icon"><i class="fa-solid ${state.pinnedProjects.includes(project.cwd) ? 'fa-thumbtack' : 'fa-folder'}"></i></span>
                <span><strong>${escapeHtml(project.name || getProjectName(project.cwd))}</strong><small>${escapeHtml(project.cwd)}</small></span>
                <em>${state.hiddenProjects.includes(state.projectAliases.get(project.cwd) || project.cwd) ? translateUi("已移出") : state.archivedProjects.has(project.cwd) ? translateUi('已归档') : project.sessionCount || 0}</em>
            </button>
        `).join('');
    }

    async function selectProject(cwd, options = {}) {
        if (!cwd) return;
        if (state.projectIdentity) {
            const input = cwd;
            cwd = state.projectAliases.get(input) || (await apiFetch(`/api/pi/projects/resolve?cwd=${encodeURIComponent(input)}`)).cwd;
            if (!cwd) throw new Error(translateUi("无法确认项目路径"));
            state.projectAliases.set(input, cwd);
        }
        if (state.hiddenProjects.includes(cwd)) {
            state.projectPreferenceRevision++;
            try {
                const data = await apiFetch('/api/pi/projects/visibility', {
                    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cwd, hidden: false })
                });
                applyHiddenProjects(data.hiddenProjects || []);
            } finally { state.projectPreferenceRevision++; }
        }
        const projectChanged = cwd !== state.cwd;
        elements.newSession.disabled = true;
        elements.tempSession.disabled = true;
        closeProjectDialog();
        state.expandedProjects.add(cwd);
        saveExpandedProjects();

        if (projectChanged) {
            disconnectSocket(true);
            state.cwd = cwd;
            state.session = null;
            state.sessions = [];
            localStorage.setItem('pi.web.cwd', cwd);
            elements.projectName.textContent = getProjectName(cwd);
            elements.projectPath.textContent = cwd;
            elements.projectInput.value = cwd;
            clearSessionView();
            setConnection('connecting', translateUi("正在读取项目会话"));
        }

        try {
            await loadSessions(cwd);
            rememberProject(cwd);
            renderProjects();
            renderSessions();
            setConnection('idle', state.session ? elements.connectionText.textContent : translateUi("选择会话开始工作"));

            if (options.restoreSession && !state.session) {
                const savedId = localStorage.getItem(`pi.web.session:${cwd}`);
                const saved = state.sessions.find(session => session.id === savedId);
                if (saved) await openSession(saved);
            }
        } finally {
            elements.newSession.disabled = false;
            elements.tempSession.disabled = false;
        }
    }

    async function loadSessions(cwd = state.cwd, options = {}) {
        if (!cwd) return [];
        const titleRevision = titleUiRevision;
        state.loadingProjects.add(cwd);
        if (options.render !== false) renderSessions();
        try {
            const data = await apiFetch(`/api/pi/sessions?cwd=${encodeURIComponent(cwd)}`);
            const sessions = data.sessions || [];
            if (titleRevision !== titleUiRevision) {
                for (const session of sessions) {
                    const current = (state.projectSessions.get(cwd) || []).find(item => item.id === session.id);
                    if (current) session.name = current.name;
                }
            }
            state.projectSessions.set(cwd, sessions);
            if (cwd === state.cwd) state.sessions = sessions;
            const project = state.projects.find(item => item.cwd === cwd);
            if (project) project.sessionCount = sessions.length;
            return sessions;
        } finally {
            state.loadingProjects.delete(cwd);
            if (options.render !== false) renderSessions();
        }
    }

    function getSessionTitle(session) {
        if (session.ephemeral) return translateUi("临时会话");
        if (session.name) return session.name;
        if (session.firstMessage && session.firstMessage !== '(no messages)') return truncate(session.firstMessage, 44);
        return translateUi("未命名会话");
    }

    // 展开的项目默认只列出前若干条线程，其余需显式点开；当前线程和搜索/筛选结果不受此上限约束。
    const THREAD_PREVIEW_LIMIT = 6;

    function threadAttentionFlags(cwd, session) {
        const key = activityKey(cwd, session.id);
        const activity = state.activityFresh ? state.activity.get(key) : null;
        return {
            attention: state.replyNotices.has(key) || Boolean(state.deferredSummary.get(key)?.attention)
                || ['waiting', 'error'].includes(activity?.phase),
            busy: Boolean(activity?.busy) && activity.phase !== 'waiting'
        };
    }

    function visibleThreads(cwd, sessions, query) {
        const capped = !query && state.sessionFilter === 'all' && !state.expandedThreadLists.has(cwd)
            && sessions.length > THREAD_PREVIEW_LIMIT;
        if (!capped) return { visible: sessions, hidden: [] };
        const visible = sessions.slice(0, THREAD_PREVIEW_LIMIT);
        const hidden = sessions.slice(THREAD_PREVIEW_LIMIT);
        const active = cwd === state.cwd && state.session
            ? hidden.find(session => session.id === state.session.id) : null;
        if (active) {
            visible.push(active);
            hidden.splice(hidden.indexOf(active), 1);
        }
        return { visible, hidden };
    }

    function threadOverflowControl(cwd, hiddenSessions, total) {
        if (hiddenSessions.length) {
            const flags = hiddenSessions.map(session => threadAttentionFlags(cwd, session));
            const summary = [
                flags.filter(item => item.busy).length && translateUi("{0} 个处理中", flags.filter(item => item.busy).length),
                flags.filter(item => item.attention).length && translateUi("{0} 个需关注", flags.filter(item => item.attention).length)
            ].filter(Boolean).join(' · ');
            return `<button class="pi-thread-more" type="button" data-project-action="more-threads" title="${translateUi("展开该项目其余 {0} 个线程", hiddenSessions.length)}"><i class="fa-solid fa-ellipsis" aria-hidden="true"></i><span>${translateUi("显示其余 {0} 个线程", hiddenSessions.length)}</span>${summary ? `<em>${summary}</em>` : ''}</button>`;
        }
        if (state.expandedThreadLists.has(cwd) && total > THREAD_PREVIEW_LIMIT) {
            return `<button class="pi-thread-more" type="button" data-project-action="less-threads"><i class="fa-solid fa-chevron-up" aria-hidden="true"></i><span>${translateUi("仅显示前 {0} 个线程", THREAD_PREVIEW_LIMIT)}</span></button>`;
        }
        return '';
    }

    function renderSessionItem(session, cwd) {
        const firstMessage = session.firstMessage === '(no messages)' ? '' : String(session.firstMessage || '').replace(/\s+/g, ' ').trim();
        const named = typeof session.name === 'string' && Boolean(session.name.trim());
        const title = session.ephemeral || named ? getSessionTitle(session) : truncate(firstMessage, 160) || translateUi("未命名会话");
        const query = elements.sessionSearch.value.trim().toLowerCase();
        const match = query ? firstMessage.toLowerCase().indexOf(query) : -1;
        let preview = session.ephemeral ? translateUi("退出或断开后立即销毁") : '';
        if (!session.ephemeral && match >= 0 && (!named || !title.toLowerCase().includes(query))) {
            const start = Math.max(0, match - 24), end = Math.min(firstMessage.length, match + query.length + 60);
            preview = `${start ? '…' : ''}${firstMessage.slice(start, end)}${end < firstMessage.length ? '…' : ''}`;
        }
        return `
            <article class="pi-session-item ${session.ephemeral ? 'ephemeral' : ''} ${state.cwd === cwd && state.session?.id === session.id ? 'active' : ''}" data-session-id="${escapeHtml(session.id)}" data-cwd="${escapeHtml(cwd)}">
                <button class="pi-session-main" type="button">
                    <span class="pi-session-project" title="${escapeHtml(cwd)}">${escapeHtml(state.projects.find(project => project.cwd === cwd)?.name || getProjectName(cwd))}</span>
                    <span class="pi-session-title ${!named && !session.ephemeral ? 'pi-session-title-fallback' : ''}" title="${escapeHtml(title)}">${escapeHtml(title)}${session.ephemeral ? `<em>${translateUi("不保存")}</em>` : ''}</span>
                    ${preview ? `<span class="pi-session-preview">${escapeHtml(preview)}</span>` : ''}
                    ${!session.ephemeral && isThreadArchived(cwd, session.id) ? `<span class="pi-session-archive-label">${state.archivedSessions.has(activityKey(cwd, session.id)) ? translateUi('已归档') : translateUi('随项目归档')}</span>` : ''}
                    <span class="pi-session-deferred" hidden></span>
                    <span class="pi-session-unread" hidden><i class="fa-solid fa-circle" aria-hidden="true"></i> ${translateUi("新回复")}</span>
                    <span class="pi-session-foot"><span class="pi-session-activity"></span><span>${session.ephemeral ? translateUi("临时") : translateUi("{0} · {1} 条", formatDate(session.modified), session.messageCount)}</span></span>
                </button>
                <div class="pi-session-actions">
                    <button type="button" data-action="menu" title="${translateUi("线程操作")}" aria-label="${translateUi("线程操作")}" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
                </div>
            </article>
        `;
    }

    function renderSessions() {
        const scrollTop = elements.sessionList.scrollTop;
        const focused = elements.sessionList.contains(document.activeElement) ? document.activeElement : null;
        const focusedWorkAction = focused?.dataset.workAction;
        const focusedCwd = focused?.closest('[data-session-id]')?.dataset.cwd || focused?.closest('[data-project-cwd]')?.dataset.projectCwd;
        const focusedSessionId = focused?.closest('[data-session-id]')?.dataset.sessionId;
        const focusSelector = focused?.classList.contains('pi-project-group-main') ? '.pi-project-group-main'
            : focused?.dataset.projectAction ? `[data-project-action="${CSS.escape(focused.dataset.projectAction)}"]`
            : focused?.dataset.action ? `[data-action="${CSS.escape(focused.dataset.action)}"]` : '.pi-session-main';
        const query = elements.sessionSearch.value.trim().toLowerCase();
        let archivedGroups = '', archivedCount = 0;
        const groups = orderedProjects().map(project => {
            const cwd = project.cwd;
            const isCurrent = cwd === state.cwd;
            const projectArchived = state.archivedProjects.has(cwd);
            if (query && projectArchived && !state.includeArchived) return '';
            const expanded = state.expandedProjects.has(cwd) || Boolean(query) || state.sessionFilter !== 'all';
            const storedSessions = state.projectSessions.get(cwd) || (isCurrent ? state.sessions : []);
            const source = isCurrent && state.session?.ephemeral
                ? [state.session, ...storedSessions]
                : storedSessions;
            const projectMatches = `${project.name || ''} ${cwd}`.toLowerCase().includes(query);
            const sessions = source.filter(session => {
                if (query && !state.includeArchived && isThreadArchived(cwd, session.id)) return false;
                const haystack = `${session.name || ''} ${session.firstMessage || ''} ${session.id}`.toLowerCase();
                return !query || projectMatches || haystack.includes(query);
            });
            const loading = state.loadingProjects.has(cwd);
            if (query && !loading && !projectMatches && !sessions.length) return '';

            let threadContent = '';
            if (loading && !source.length) {
                threadContent = `<div class="pi-project-loading"><span class="pi-spinner"></span>${translateUi("正在读取线程")}</div>`;
            } else if (expanded && sessions.length) {
                const archived = state.sessionFilter === 'all' ? sessions.filter(session => state.archivedSessions.has(activityKey(cwd, session.id))) : [];
                const regular = sessions.filter(session => state.sessionFilter !== 'all' || !state.archivedSessions.has(activityKey(cwd, session.id)));
                const { visible, hidden } = visibleThreads(cwd, regular, query);
                threadContent = visible.map(session => renderSessionItem(session, cwd)).join('')
                    + (!query && state.sessionFilter === 'all' ? threadOverflowControl(cwd, hidden, regular.length) : '')
                    + (archived.length ? `<details class="pi-archive-group" data-archive-kind="threads" data-cwd="${escapeHtml(cwd)}" ${state.archiveThreadsOpen.has(cwd) || query ? 'open' : ''}><summary>${translateUi('已归档线程（{0}）', archived.length)}</summary>${archived.map(session => renderSessionItem(session, cwd)).join('')}</details>` : '');
            } else if (expanded) {
                threadContent = `<div class="pi-project-empty">${translateUi("暂无线程")}</div>`;
            }

            const groupHtml = `
                <section class="pi-project-group ${state.pinnedProjects.includes(cwd) ? 'pinned' : ''} ${isCurrent ? 'current' : ''} ${expanded ? 'expanded' : ''}" data-project-cwd="${escapeHtml(cwd)}">
                    <div class="pi-project-group-heading">
                        <button class="pi-project-disclosure" type="button" data-project-action="toggle" title="${expanded ? translateUi("折叠线程") : translateUi("展开线程")}" aria-label="${translateUi("{0} {1} 的线程", expanded ? translateUi("折叠") : translateUi("展开"), escapeHtml(project.name || getProjectName(cwd)))}" aria-expanded="${expanded}">
                            <i class="fa-solid fa-chevron-right"></i>
                        </button>
                        <button class="pi-project-group-main" type="button" data-project-action="toggle" aria-expanded="${expanded}" title="${translateUi("{0}（点击{1}线程，点击线程打开项目）", escapeHtml(cwd), expanded ? translateUi("折叠") : translateUi("展开"))}">
                            <span class="pi-project-group-icon"><i class="fa-regular ${expanded ? 'fa-folder-open' : 'fa-folder'}"></i></span>
                            <span class="pi-project-group-copy"><strong>${escapeHtml(project.name || getProjectName(cwd))}</strong><small>${escapeHtml(cwd)}</small><span class="pi-project-activity" hidden></span></span>
                        </button>
                        <span class="pi-project-session-count">${storedSessions.length || project.sessionCount || 0}</span>
                        <button class="pi-project-pin" type="button" data-project-action="pin" aria-pressed="${state.pinnedProjects.includes(cwd)}" title="${state.pinnedProjects.includes(cwd) ? translateUi("已置顶，点击取消") : translateUi("置顶项目")}" aria-label="${state.pinnedProjects.includes(cwd) ? translateUi("取消置顶") : translateUi("置顶项目")} ${escapeHtml(project.name || getProjectName(cwd))}" ${state.pinRequests.has(cwd) ? 'disabled' : ''}><i class="fa-solid fa-thumbtack" aria-hidden="true"></i></button>
                        <button class="pi-project-new" type="button" data-project-action="menu" title="${translateUi("项目操作")}" aria-label="${translateUi("项目操作")}" aria-haspopup="menu" aria-expanded="false"><i class="fa-solid fa-ellipsis"></i></button>
                    </div>
                    <div class="pi-project-threads ${expanded ? '' : 'hidden'}">${threadContent}</div>
                </section>
            `;
            if (projectArchived && state.sessionFilter === 'all') { archivedGroups += groupHtml; archivedCount++; return ''; }
            return groupHtml;
        }).join('');
        const archiveSection = archivedCount ? `<details class="pi-archive-group pi-archived-projects" data-archive-kind="projects" ${state.archiveProjectsOpen || query ? 'open' : ''}><summary>${translateUi('已归档项目（{0}）', archivedCount)}</summary>${archivedGroups}</details>` : '';

        elements.sessionCount.textContent = translateUi("{0} 个项目 · {1} 个当前线程", orderedProjects().length, state.sessions.length);
        elements.sessionList.innerHTML = groups + archiveSection || (state.sessionFilter === 'work' ? '' : `<div class="pi-list-state">${query ? translateUi("没有匹配的项目或线程") : translateUi("还没有 Pi 项目")}</div>`);
        renderActivityBadges();
        elements.sessionList.scrollTop = scrollTop;
        if (focusedWorkAction) elements.sessionList.querySelector(`[data-work-action="${CSS.escape(focusedWorkAction)}"]`)?.focus({ preventScroll: true });
        if (focusedCwd) {
            const scope = focusedSessionId
                ? `[data-cwd="${CSS.escape(focusedCwd)}"][data-session-id="${CSS.escape(focusedSessionId)}"]`
                : `[data-project-cwd="${CSS.escape(focusedCwd)}"]`;
            elements.sessionList.querySelector(`${scope} ${focusSelector}`)?.focus({ preventScroll: true });
        }
    }

    async function loadFilteredProjects() {
        if (state.sessionFilter === 'all') return;
        const relevant = [...state.activity.values(), ...state.replyNotices.values(), ...state.deferredSummary.values()];
        const cwds = new Set(relevant.map(item => item.cwd));
        if (state.sessionFilter === 'work') {
            for (const project of orderedProjects()) if (project.sessionCount > 0) cwds.add(project.cwd);
        }
        const unloaded = [...cwds].filter(cwd => !state.loadingProjects.has(cwd)
            && (!state.projectSessions.has(cwd) || relevant.some(item => item.cwd === cwd
                && !state.projectSessions.get(cwd).some(session => session.id === item.sessionId))));
        if (unloaded.length) {
            const requests = unloaded.map(cwd => loadSessions(cwd, { render: false }));
            renderActivityBadges();
            await Promise.allSettled(requests);
            renderSessions();
        } else renderActivityBadges();
    }

    function isViewingSession() {
        if (innerWidth <= 900 && elements.inspector.classList.contains('open')) return false;
        return !document.hidden && $('chat-tab').classList.contains('active') && state.connected && state.session
            && !(window.innerWidth <= 900 && elements.sessionPane.classList.contains('open'));
    }

    async function markThreadUnread(session, cwd) {
        const key = activityKey(cwd, session.id);
        if (session.ephemeral || !state.manualUnread || state.unreadRequests.has(key)) return;
        state.unreadRequests.add(key);
        state.noticeRevision++;
        try {
            const { notice } = await apiFetch(`/api/pi/sessions/${encodeURIComponent(session.id)}/unread`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd })
            });
            if (!notice?.completionId || notice.cwd !== cwd || notice.sessionId !== session.id) throw new Error(translateUi("未读标记未得到确认"));
            state.replyNotices.set(key, notice);
            renderActivityBadges();
        } finally {
            state.unreadRequests.delete(key);
            state.noticeRevision++;
        }
    }

    async function markReplyRead(notice) {
        if (!notice || state.readRequests.has(notice.completionId)) return;
        state.readRequests.add(notice.completionId);
        state.noticeRevision++;
        try {
            await apiFetch(`/api/pi/sessions/${encodeURIComponent(notice.sessionId)}/read`, {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: notice.cwd, completionId: notice.completionId })
            });
            const key = activityKey(notice.cwd, notice.sessionId);
            if (state.replyNotices.get(key)?.completionId === notice.completionId) state.replyNotices.delete(key);
            renderActivityBadges();
        } finally {
            state.readRequests.delete(notice.completionId);
            state.noticeRevision++;
        }
    }

    async function acknowledgeRenderedReply() {
        const notice = state.renderedCompletion;
        if (!notice || !isViewingSession() || state.session.id !== notice.sessionId || state.cwd !== notice.cwd) return;
        if (state.replyNotices.get(activityKey(notice.cwd, notice.sessionId))?.completionId !== notice.completionId) return;
        try { await markReplyRead(notice); } catch {}
    }

    async function toggleProject(cwd) {
        if (state.expandedProjects.has(cwd)) {
            state.expandedProjects.delete(cwd);
            state.expandedThreadLists.delete(cwd);
        } else {
            state.expandedProjects.add(cwd);
            if (!state.projectSessions.has(cwd)) {
                renderSessions();
                try {
                    await loadSessions(cwd);
                } catch (error) {
                    toast(error.message, 'error');
                }
            }
        }
        saveExpandedProjects();
        renderSessions();
    }

    function setSessionSearchOpen(open) {
        elements.sessionSearchField.hidden = !open;
        archiveSearchLabel.hidden = !open || !state.archiveEnabled;
        elements.sessionHeadingTitle.hidden = open;
        elements.tempSession.hidden = open;
        elements.sessionSearchToggle.setAttribute('aria-expanded', String(open));
        const label = open ? translateUi("退出搜索") : translateUi("搜索项目或线程");
        elements.sessionSearchToggle.title = label;
        elements.sessionSearchToggle.setAttribute('aria-label', label);
        elements.sessionSearchToggle.firstElementChild.className = `fa-solid ${open ? 'fa-xmark' : 'fa-magnifying-glass'}`;
        if (open) {
            elements.sessionSearch.focus({ preventScroll: true });
        } else {
            elements.sessionSearch.value = '';
            void handleSessionSearch().catch(error => toast(error.message, 'error'));
            elements.sessionSearchToggle.focus({ preventScroll: true });
        }
    }

    let searchGeneration = 0;
    async function handleSessionSearch() {
        const generation = ++searchGeneration;
        renderSessions();
        if (!elements.sessionSearch.value.trim()) return;
        const unloaded = state.projects.filter(project => !state.projectSessions.has(project.cwd));
        await Promise.allSettled(unloaded.map(project => loadSessions(project.cwd, { render: false })));
        if (generation === searchGeneration) renderSessions();
    }

    async function createEphemeralSession() {
        if (!state.cwd) return openProjectDialog();
        elements.tempSession.disabled = true;
        const now = new Date().toISOString();
        const session = {
            id: `ephemeral-${Date.now()}`,
            path: null,
            cwd: state.cwd,
            name: translateUi("临时会话"),
            firstMessage: '',
            messageCount: 0,
            created: now,
            modified: now,
            ephemeral: true
        };
        try {
            await openSession(session);
            elements.input.focus();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            elements.tempSession.disabled = false;
        }
    }

    async function createSession() {
        if (!state.cwd) return openProjectDialog();
        elements.newSession.disabled = true;
        try {
            const session = await apiFetch('/api/pi/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd: state.cwd })
            });
            state.sessions.unshift(session);
            state.projectSessions.set(state.cwd, state.sessions);
            const project = state.projects.find(item => item.cwd === state.cwd);
            if (project) project.sessionCount = state.sessions.length;
            rememberProject(state.cwd);
            renderProjects();
            renderSessions();
            await openSession(session);
            elements.input.focus();
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            elements.newSession.disabled = false;
        }
    }

    async function renameCurrent(session = state.session, cwd = session?.cwd || state.cwd) {
        if (!session || session.ephemeral || !cwd) return;
        const current = getSessionTitle(session);
        const name = window.prompt(translateUi("会话名称"), current);
        if (!name || name.trim() === current) return;
        try {
            const renamed = await apiFetch(`/api/pi/sessions/${encodeURIComponent(session.id)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, name: name.trim() })
            });
            sessionNamed(session, cwd, renamed.name);
            toast(translateUi("会话已重命名"), 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function deleteOneSession(session = state.session, cwd = session?.cwd || state.cwd) {
        if (!session || session.ephemeral || !cwd) return;
        if (!window.confirm(translateUi("删除会话“{0}”？\n会先尝试将会话文件移入回收站；回收站不可用时将永久删除。", getSessionTitle(session)))) return;
        try {
            const result = await apiFetch(`/api/pi/sessions/${encodeURIComponent(session.id)}?cwd=${encodeURIComponent(cwd)}`, {
                method: 'DELETE'
            });
            sideChat.forget(JSON.stringify([cwd, session.id]));
            const wasCurrent = state.cwd === cwd && state.session?.id === session.id;
            if (wasCurrent) {
                disconnectSocket(true);
                state.session = null;
                clearSessionView();
            }
            const nextSessions = (state.projectSessions.get(cwd) || []).filter(item => item.id !== session.id);
            state.projectSessions.set(cwd, nextSessions);
            if (state.cwd === cwd) state.sessions = nextSessions;
            const project = state.projects.find(item => item.cwd === cwd);
            if (project) project.sessionCount = nextSessions.length;
            renderProjects();
            renderSessions();
            toast(result?.trashed === true ? translateUi("会话已移入回收站") : result?.trashed === false ? translateUi("会话已永久删除") : translateUi("会话已删除"), 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function openSession(session) {
        if (!session || state.session?.id === session.id && state.connected) return;
        turnEdits.reset();
        const draftKey = JSON.stringify([state.cwd, session.id]);
        if (state.composerSessionKey !== draftKey) {
            state.attachmentEpoch++;
            state.attachmentReads = 0;
            state.attachmentQueue = Promise.resolve();
            $('pi-attachment-preview').close();
            if (state.composerSessionKey) state.composerDrafts.set(state.composerSessionKey, { text: elements.input.value, files: state.attachmentFiles });
            const draft = state.composerDrafts.get(draftKey);
            elements.input.value = draft?.text || '';
            state.attachmentFiles = draft?.files || [];
            state.composerSessionKey = draftKey;
            renderAttachments(); autoResizeInput();
        }
        state.session = session;
        extensionAssistant.update(session);
        workflows.update();
        if (!session.ephemeral) localStorage.setItem(`pi.web.session:${state.cwd}`, session.id);
        renderSessions();
        updateSessionMeta();
        elements.input.disabled = true;
        elements.sendButton.disabled = true;
        elements.compactButton.disabled = true;
        elements.currentThreadMenu.disabled = false;
        transcriptScroll.reset();
        elements.transcript.innerHTML = `<div class="pi-transcript-loading"><span class="pi-spinner"></span><span>${session.ephemeral ? translateUi("正在启动临时 Pi runtime") : translateUi("正在加载 Pi session")}</span></div>`;
        setConnection('connecting', translateUi("正在启动 Pi runtime"));
        setAgentState('connecting', translateUi("正在启动"), getSessionTitle(session));
        const openedCwd = state.cwd;
        await connectSocket(session);
        if (!session.ephemeral && state.cwd === openedCwd && state.session?.id === session.id) {
            const key = activityKey(openedCwd, session.id);
            state.recentlyOpened.delete(key);
            state.recentlyOpened.set(key, ++state.recentOpenSequence);
            if (state.recentlyOpened.size > 32) state.recentlyOpened.delete(state.recentlyOpened.keys().next().value);
            renderActivityBadges();
        }
        if (window.innerWidth <= 900) elements.sessionPane.classList.remove('open');
    }

    function connectSocket(session) {
        disconnectSocket(true);
        const generation = ++state.socketGeneration;
        state.intentionalClose = false;
        return new Promise((resolve, reject) => {
            const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
            const socket = new WebSocket(`${protocol}//${location.host}/api/pi/ws`);
            state.socket = socket;

            socket.addEventListener('open', async () => {
                if (generation !== state.socketGeneration) return;
                try {
                    const openCommand = session.ephemeral ? 'open_ephemeral' : 'open_session';
                    const payload = { token: state.token, cwd: state.cwd };
                    if (!session.ephemeral) payload.sessionId = session.id;
                    const snapshot = await requestRpc(openCommand, payload, 180000);
                    if (generation !== state.socketGeneration) return reject(new Error('Session changed'));
                    state.connected = true;
                    applySnapshot(snapshot);
                    const buffered = state.bootstrapEvents || []; state.bootstrapEvents = null;
                    const live = snapshot.messages?.webLive;
                    for (const event of buffered) {
                        if (live && event.webRuntimeId && event.webRuntimeId !== live.runtimeId) continue;
                        if (!live || !event.webRuntimeId || event.webSequence > live.sequence
                            || event.type === 'extension_error' || event.type === 'extension_ui_request' && event.method === 'notify') handlePiEvent(event);
                    }
                    setConnection(state.shellBusy || state.compacting || state.streaming ? 'working' : 'connected', state.shellBusy ? translateUi("Shell 正在执行") : state.compacting ? translateUi("正在压缩上下文") : state.streaming ? translateUi("Pi 正在执行") : translateUi("Pi Agent 已连接"));
                    resolve();
                } catch (error) {
                    if (generation === state.socketGeneration && state.socket === socket) {
                        if (['STARTUP_UI_UNSUPPORTED', 'RPC_STARTUP_FAILED'].includes(error.errorCode)) {
                            state.intentionalClose = true;
                            elements.transcript.replaceChildren(); appendEventNotice('error', error.message);
                            const actions = document.createElement('div'); actions.className = 'pi-startup-actions';
                            for (const [label, action] of [[translateUi("重试连接"), () => void connectSocket(session).catch(() => {})], [translateUi("管理扩展"), () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'packages' } }))]]) {
                                const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.addEventListener('click', action); actions.append(button);
                            }
                            elements.transcript.append(actions);
                        }
                        socket.close(4000, 'Session open failed');
                        setConnection('error', error.message);
                        toast(error.message, 'error');
                    }
                    reject(error);
                }
            });
            socket.addEventListener('message', event => {
                if (generation === state.socketGeneration && state.socket === socket) handleSocketRecord(event.data);
            });
            socket.addEventListener('close', event => {
                if (generation !== state.socketGeneration) return;
                sideChat.parentDisconnected();
                state.connected = false;
                nativeControls.disconnected();
                setStreaming(state.streaming);
                state.pendingUi.clear();
                closeRequestDialog();
                renderPendingUi();
                rejectPending(new Error(event.reason || 'Pi Agent connection closed'));
                if (event.code === 4401) {
                    clearTimeout(state.reconnectTimer);
                    if (window.WorkspaceAccess?.supported) void window.WorkspaceAccess.refresh();
                    else showTokenDialog();
                    setConnection('error', translateUi("访问验证已失效，请重新登录"));
                    return;
                }
                if (!state.intentionalClose && state.session && !state.session.ephemeral) {
                    setConnection('error', translateUi("连接中断，正在重连"));
                    clearTimeout(state.reconnectTimer);
                    state.reconnectTimer = setTimeout(() => connectSocket(state.session).catch(() => {}), 1800);
                } else if (state.session?.ephemeral) {
                    setConnection('idle', translateUi("临时会话已结束"));
                    elements.input.disabled = true;
                }
            });
            socket.addEventListener('error', () => {
                if (generation === state.socketGeneration) setConnection('error', translateUi("Pi Agent 连接失败"));
            });
        });
    }

    function disconnectSocket(intentional = false) {
        taskResults?.reset();
        titleEditor?.close();
        threadMenu.close(false);
        state.socketGeneration++;
        state.bootstrapEvents = [];
        state.bootstrapBytes = 0;
        editorSuggestions.reset();
        state.resourceRequested = false;
        state.treeBusy = false;
        state.compactDraft = null;
        composer.reset();
        state.connected = false;
        state.streaming = false;
        nativeControls.reset();
        shell.reset(); state.shellBusy = false;
        state.controlRequested = false;
        state.controlsStopping = false;
        elements.queue.classList.add('hidden');
        elements.queue.replaceChildren();
        window.PiReplyTts.reset();
        selectionActions.hide();
        state.compactRequested = false;
        state.compacting = false;
        state.compaction = null;
        state.runtimeRevision++;
        state.pendingUi.clear();
        state.renderedCompletion = null;
        closeRequestDialog();
        renderPendingUi();
        clearTimeout(state.reconnectTimer);
        state.intentionalClose = intentional;
        if (state.socket) {
            state.socket.close(1000, 'Switching session');
            state.socket = null;
        }
        state.connected = false;
        nativeContext.sync();
        sideChat.updateParent();
        rejectPending(new Error('Session changed'));
    }

    function rejectPending(error) {
        for (const pending of state.requests.values()) {
            clearTimeout(pending.timer);
            pending.reject(Object.assign(new Error(error.message), { deliveryUnknown: true }));
        }
        state.requests.clear();
    }

    function requestRpc(type, payload = {}, timeoutMs = 45000) {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error(translateUi("Pi Agent 尚未连接")));
        }
        const id = `browser-${state.nextRequestId++}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                state.requests.delete(id);
                reject(Object.assign(new Error(translateUi("{0} 请求超时", type)), { deliveryUnknown: true }));
            }, timeoutMs);
            state.requests.set(id, { resolve, reject, timer });
            try { state.socket.send(JSON.stringify({ id, type, ...payload })); }
            catch (error) { clearTimeout(timer); state.requests.delete(id); reject(error); }
        });
    }

    function sendExtensionResponse(payload) {
        if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
        state.socket.send(JSON.stringify({ type: 'extension_ui_response', ...payload }));
    }

    function handleSocketRecord(raw) {
        let record;
        try {
            record = JSON.parse(raw);
        } catch {
            return;
        }
        if (record.type === 'response' && record.id && state.requests.has(record.id)) {
            const pending = state.requests.get(record.id);
            state.requests.delete(record.id);
            clearTimeout(pending.timer);
            if (record.success) pending.resolve(record.data);
            else {
                const message = record.error || translateUi("{0}失败", record.command || translateUi("请求"));
                pending.reject(Object.assign(new Error(translateUi(message)), { errorCode: record.errorCode, deliveryUnknown: /timed out|timeout|exited|closed|EPIPE|ECONNRESET|not running/i.test(message) }));
            }
            return;
        }
        if (state.bootstrapEvents) {
            state.bootstrapBytes += raw.length;
            if (state.bootstrapBytes > 8 * 1024 * 1024 || state.bootstrapEvents.length >= 10000) {
                state.intentionalClose = true; setConnection('error', translateUi("初始化期间事件过多，请重新打开线程"));
                state.socket.close(4008, translateUi("初始化期间事件过多，请重新打开线程")); return;
            }
            state.bootstrapEvents.push(record); return;
        }
        handlePiEvent(record);
    }

    function restoreLive(live) {
        if (!live) return;
        if (live.message) {
            startLiveMessage(live.message);
            (live.message.content || []).forEach((block, contentIndex) => {
                if (!block) return;
                if (block.type === 'toolCall') updateLiveMessage({ type: 'toolcall_end', contentIndex, toolCall: block });
                else updateLiveMessage({ type: block.type === 'thinking' ? 'thinking_delta' : 'text_delta', contentIndex, delta: block.text || block.thinking || '' });
            });
        }
        for (const event of live.tools || []) updateToolExecution(event, event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running');
        if (live.truncated) appendEventNotice('info', translateUi("运行现场超过恢复预览限额，部分内容未显示；最终消息以 Pi 完成记录为准。"));
    }

    function applySnapshot(snapshot) {
        if (state.modelRefreshOp?.generation !== state.socketGeneration) state.modelRefreshOp = null;
        state.modelAuthError = false;
        state.modelRefreshError = '';
        state.model = snapshot.state?.model || null;
        state.thinkingLevel = snapshot.state?.thinkingLevel || 'off';
        state.streaming = Boolean(snapshot.state?.isStreaming);
        state.compacting = Boolean(snapshot.state?.isCompacting);
        state.compaction = snapshot.state?.webCompaction || null;
        state.models = snapshot.models?.models || [];
        state.thinkingLevels = snapshot.thinkingLevels?.levels || ['off'];
        composer.setCommands(snapshot.commands?.commands || []);
        void composer.run(() => composer.load());
        state.stats = snapshot.stats || null;
        state.session = { ...state.session, ...(snapshot.session || {}) };
        extensionAssistant.update(state.session);
        renderSessions();
        renderModels();
        renderThinkingLevels();
        renderMessages(snapshot.messages?.messages || []);
        restoreLive(snapshot.messages?.webLive);
        state.renderedCompletion = snapshot.completion || null;
        window.PiPageNotifications?.observeCompletion(state.renderedCompletion);
        state.pendingUi = new Map((snapshot.pendingUi || []).map(event => [event.id, event]));
        renderPendingUi();
        void acknowledgeRenderedReply();
        updateStats(snapshot.stats);
        updateRuntimeState(snapshot.state || {});
        updateSessionMeta(snapshot.state);
        nativeControls.apply(snapshot.controls || snapshot.state?.webControls);
        elements.input.disabled = false;
        elements.sendButton.disabled = false;
        elements.compactButton.disabled = false;
        elements.currentThreadMenu.disabled = !state.session;
        elements.autoCompact.checked = snapshot.state?.autoCompactionEnabled !== false;
        setStreaming(state.streaming);
        setAgentState(
            state.compacting || state.streaming || state.shellBusy ? 'working' : 'connected',
            state.shellBusy ? translateUi("Shell 执行中") : state.compacting ? translateUi("压缩中") : state.streaming ? translateUi("执行中") : translateUi("空闲"),
            state.model ? `${state.model.provider}/${state.model.id}` : 'Pi Agent'
        );
        autoResizeInput();
        void workflows.refresh(true).catch(() => {});
        if (state.modelCatalogSupported) void refreshSessionModels();
    }

    function usableSessionModel() {
        return !state.modelAuthError && state.models.some(m => m.provider === state.model?.provider && m.id === state.model?.id);
    }

    function syncModelGuidance() {
        const ready = usableSessionModel();
        const busy = state.streaming || state.compacting || state.compactRequested || state.shellBusy || state.treeBusy || state.resourceRequested || state.controlRequested;
        elements.modelRefresh.disabled = !state.connected || busy || Boolean(state.modelRefreshOp);
        elements.modelChoose.disabled = !state.connected || busy || Boolean(state.modelRefreshOp) || !state.models.length;
        elements.modelGuidance.hidden = !state.connected || (ready && !state.modelRefreshError);
        elements.modelGuidanceText.textContent = state.modelRefreshOp ? (state.modelRefreshOp.kind === 'selection' ? translateUi("正在切换本会话的模型…") : translateUi("正在更新当前会话的可用模型…")) : state.modelRefreshError
            || (state.modelAuthError ? translateUi("当前模型的认证不可用。请重新登录供应商，或选择其他已接入模型。")
                : state.models.length ? translateUi("请选择本会话使用的模型。设置中的默认模型不会自动替换已打开会话的模型。")
                    : translateUi("当前没有可用的聊天模型。请先在“供应商与模型”中登录并检查模型配置，再返回选择。"));
    }

    async function refreshSessionModels() {
        if (!state.connected) return;
        state.modelRefreshPending = true;
        if (state.streaming || state.compacting || state.compactRequested || state.shellBusy || state.treeBusy || state.resourceRequested || state.controlRequested || state.modelRefreshOp) return;
        if (!$('workspace-settings-dialog').classList.contains('hidden')) return;
        state.modelRefreshPending = false;
        const operation = { generation: state.socketGeneration };
        state.modelRefreshOp = operation; state.modelRefreshError = ''; setStreaming(state.streaming); syncModelGuidance();
        try {
            const data = await requestRpc(state.modelCatalogSupported ? 'refresh_models' : 'get_available_models', {}, 20000);
            if (operation.generation !== state.socketGeneration || state.modelRefreshOp !== operation) return;
            state.models = data.models || []; state.modelAuthError = false;
            if (!state.modelCatalogSupported && !state.models.length) state.modelRefreshError = translateUi("尚无可用模型。请先完成供应商设置；旧后端需在空闲时退出并重开线程后读取新配置。");
            renderModels();
        } catch (error) {
            if (operation.generation === state.socketGeneration && state.modelRefreshOp === operation) state.modelRefreshError = error.message;
        } finally {
            if (state.modelRefreshOp === operation) {
                state.modelRefreshOp = null;
                if (operation.generation === state.socketGeneration) {
                    setStreaming(state.streaming); syncModelGuidance();
                    if (state.modelRefreshPending) queueMicrotask(() => void refreshSessionModels());
                }
            }
        }
    }

    function renderModels() {
        const groups = new Map();
        for (const model of state.models) {
            if (!groups.has(model.provider)) groups.set(model.provider, []);
            groups.get(model.provider).push(model);
        }
        const available = state.models.some(m => m.provider === state.model?.provider && m.id === state.model?.id);
        const placeholder = available ? '' : `<option value="" disabled selected>${state.models.length ? translateUi("请选择已接入的模型") : translateUi("尚无可用模型")}</option>`;
        elements.modelSelect.innerHTML = placeholder + [...groups.entries()].map(([provider, models]) => `
            <optgroup label="${escapeHtml(provider)}">
                ${models.map(model => `<option value="${escapeHtml(`${model.provider}|||${model.id}`)}">${escapeHtml(model.name || model.id)}</option>`).join('')}
            </optgroup>
        `).join('');
        elements.modelSelect.value = available ? `${state.model.provider}|||${state.model.id}` : '';
        elements.modelSelect.disabled = !state.connected || !state.models.length || Boolean(state.modelRefreshOp);
        syncModelGuidance();
    }

    function renderThinkingLevels() {
        const labels = { off: translateUi("不启用"), minimal: translateUi("极简"), low: translateUi("低"), medium: translateUi("中"), high: translateUi("高"), xhigh: translateUi("极高"), max: translateUi("最大") };
        elements.thinkingSelect.innerHTML = state.thinkingLevels.map(level => `<option value="${escapeHtml(level)}">${labels[level] || level}</option>`).join('');
        elements.thinkingSelect.value = state.thinkingLevel;
        elements.thinkingSelect.disabled = state.thinkingLevels.length <= 1;
    }

    function messageText(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.filter(block => block.type === 'text').map(block => block.text).join('\n');
    }

    function createMessageElement(message, showReplyActions = false) {
        const element = createMessageContentElement(message, showReplyActions);
        if (element && message.role === 'custom') element._piCustomMessage = message;
        if (element && message.timestamp != null) {
            element.dataset.messageKey = JSON.stringify([message.role, message.timestamp, message.toolCallId || '']);
            element.querySelectorAll('.pi-message-body > *').forEach((block, index) => {
                block.dataset.readingKey = `${element.dataset.messageKey}:${index}`;
                if (block.tagName === 'DETAILS') block.dataset.detailKey ||= block.dataset.readingKey;
            });
        }
        return element;
    }

    const messageTimeFormat = new Intl.DateTimeFormat(globalThis.PiI18n?.locale || 'zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    });

    function createMessageCopy(text, role) {
        const button = document.createElement('button');
        button.className = 'pi-message-copy pi-message-action';
        button.type = 'button';
        button.title = role === 'user' ? translateUi("复制问题") : translateUi("复制回复");
        button.setAttribute('aria-label', button.title);
        button.innerHTML = '<i class="fa-regular fa-copy" aria-hidden="true"></i>';
        button._piCopyText = text;
        button.disabled = !text.trim();
        if (button.disabled) button.title = translateUi("此消息没有可复制的文本");
        return button;
    }

    function appendAgentThreadLink(header, target, label) {
        if (!target || typeof target.cwd !== 'string' || !target.cwd || target.cwd.length > 4096
            || typeof target.id !== 'string' || !target.id || target.id.length > 300) return;
        const reference = { cwd: target.cwd, id: target.id };
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'pi-agent-thread-link'; button.textContent = label;
        button.addEventListener('click', async () => {
            if (state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) {
                toast(translateUi('请等待附件读取或消息投递完成'), 'info'); return;
            }
            const generation = state.socketGeneration, cwd = state.cwd;
            button.disabled = true;
            try {
                // Historical task metadata keeps its original cwd. Resolve an
                // old path only on click; never navigate outside this project.
                if (reference.cwd !== cwd) {
                    const resolved = await apiFetch(`/api/pi/projects/resolve?cwd=${encodeURIComponent(reference.cwd)}`);
                    if (generation !== state.socketGeneration || cwd !== state.cwd) return;
                    const current = state.session?.cwd || state.projectAliases.get(cwd) || cwd;
                    if (!resolved.cwd || resolved.cwd !== current) throw new Error(translateUi('原会话已不存在，请从会话列表选择其他会话。'));
                }
                const rows = await loadSessions(cwd);
                if (generation !== state.socketGeneration || cwd !== state.cwd) return;
                const session = rows.find(row => row.id === reference.id);
                if (!session) throw new Error(translateUi('原会话已不存在，请从会话列表选择其他会话。'));
                await openSession(session);
            } catch (error) { toast(error.message, 'error'); }
            finally { button.disabled = false; }
        });
        header.appendChild(button);
    }

    function foldLongUserText(text, source) {
        // Deliberately generous: ordinary multi-paragraph prompts remain fully visible.
        if (source.length <= 2400 && source.split(/\r\n|\r|\n/).length <= 30) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'pi-user-text-toggle';
        const update = expanded => {
            text.classList.toggle('pi-user-text-collapsed', !expanded);
            button.setAttribute('aria-expanded', String(expanded));
            button.textContent = translateUi(expanded ? '收起全文' : '展开全文');
        };
        text.classList.add('pi-user-long-text');
        text._piSetExpanded = update;
        update(false);
        button.addEventListener('click', () => {
            const top = text.getBoundingClientRect().top;
            const expanded = button.getAttribute('aria-expanded') === 'true';
            update(!expanded);
            // Keep the beginning reachable when collapsing a message read far below it.
            if (expanded && top < transcriptScroll.viewport.getBoundingClientRect().top) {
                text.scrollIntoView({ block: 'start' });
            }
        });
        text.after(button);
    }

    function createMessageContentElement(message, showReplyActions) {
        const role = message.role || 'custom';
        if (role === 'toolResult') return createToolResultElement(message);
        if (role === 'bashExecution') return createBashElement(message);
        if (role === 'compactionSummary' || role === 'branchSummary') return createNoticeElement(role, message.summary || message.content || '');
        if (role === 'custom' && message.display === false) return null;

        const article = document.createElement('article');
        article.className = `pi-message ${role}`;
        if (role === 'user') article._piUserMessage = message;
        if (role === 'assistant') article._piAssistantMessage = message;
        const header = document.createElement('header');
        const title = role === 'user' ? translateUi("你") : role === 'assistant' ? 'Pi' : translateUi("系统");
        const model = role === 'assistant' && message.model ? `<span>${escapeHtml(message.model)}</span>` : '';
        header.innerHTML = `<strong>${title}</strong>${model}`;
        if (role === 'custom' && ['pivane-agent-task-message', 'pivane-agent-task-receipt', 'pi5-agent-task-message', 'pi5-agent-task-receipt'].includes(message.customType)) {
            article.classList.add('pi-agent-thread-message');
            const receipt = ['pivane-agent-task-receipt', 'pi5-agent-task-receipt'].includes(message.customType);
            header.querySelector('strong').textContent = translateUi(receipt ? 'Agent 任务线程' : '来自 Agent 的任务');
            const details = message.details || {};
            if (receipt) {
                const meta = document.createElement('span'); meta.className = 'pi-agent-thread-meta';
                const labels = { saved: '任务已保存，尚未确认启动', submitted: '任务已提交', running: '运行中', tool: '运行中', retrying: '运行中', compacting: '运行中', waiting: '等待处理', completed: '已完成', error: '执行失败', stopped: '已停止', uncertain: '启动状态待核实' };
                meta.textContent = [details.model?.provider, details.model?.modelId, details.thinkingLevel,
                    translateUi('创建时状态：{0}', translateUi(typeof details.status === 'string' && Object.hasOwn(labels, details.status) ? labels[details.status] : '启动状态待核实'))]
                    .filter(value => typeof value === 'string' && value).join(' · ');
                header.appendChild(meta);
                appendAgentThreadLink(header, details.session, translateUi('打开任务线程'));
            } else appendAgentThreadLink(header, { cwd: details.source?.cwd, id: details.source?.sessionId }, translateUi('查看来源线程'));
        }
        if (role === 'custom' && message.customType === 'pivane-agent-task-result') {
            article.classList.add('pi-agent-thread-message');
            window.PiTaskResults?.decorate(header, message.details || {}, appendAgentThreadLink);
        }
        const responseText = role === 'assistant' ? messageText(message.content).trim() : '';
        if (responseText) state.lastAssistantText = responseText;
        if (role === 'user') {
            if (typeof message.timestamp === 'number' || typeof message.timestamp === 'string') {
                const sentAt = new Date(message.timestamp);
                if (Number.isFinite(sentAt.getTime())) {
                    const time = document.createElement('time');
                    time.className = 'pi-message-time';
                    time.dateTime = sentAt.toISOString();
                    time.textContent = messageTimeFormat.format(sentAt);
                    time.title = sentAt.toLocaleString(globalThis.PiI18n?.locale || 'zh-CN', { hour12: false });
                    header.appendChild(time);
                }
            }
            const actions = document.createElement('span');
            actions.className = 'pi-user-actions';
            actions.appendChild(createMessageCopy(messageText(message.content), role));
            header.appendChild(actions);
        }
        article.appendChild(header);

        const body = document.createElement('div');
        body.className = 'pi-message-body';
        const content = Array.isArray(message.content) ? message.content : [{ type: 'text', text: message.content || '' }];
        for (const block of content) {
            if (block.type === 'text') {
                const text = document.createElement('div');
                text.className = 'pi-markdown';
                if (role === 'assistant') text.innerHTML = renderMarkdown(block.text);
                else window.PiQuotes.renderUser(text, block.text);
                body.appendChild(text);
                if (role === 'user') foldLongUserText(text, block.text || '');
            } else if (block.type === 'thinking') {
                body.appendChild(createThinkingBlock(block.thinking));
            } else if (block.type === 'toolCall') {
                body.appendChild(createToolCallBlock(block));
            } else if (block.type === 'image') {
                const image = document.createElement('img');
                image.className = 'pi-message-image';
                image.src = `data:${block.mimeType};base64,${block.data}`;
                image.alt = translateUi("消息附件");
                body.appendChild(image);
            }
        }
        if (message.stopReason === 'aborted') {
            const stopped = document.createElement('div');
            stopped.className = 'pi-inline-stopped';
            stopped.textContent = translateUi("回复已停止");
            body.appendChild(stopped);
            if (message.errorMessage) {
                const details = document.createElement('details'); details.className = 'pi-stop-details';
                const summary = document.createElement('summary'); summary.textContent = translateUi("停止详情");
                const reason = document.createElement('pre'); reason.textContent = message.errorMessage;
                details.append(summary, reason); body.appendChild(details);
            }
        } else if (message.stopReason === 'length') {
            const notice = document.createElement('div'); notice.className = 'pi-inline-stopped';
            notice.textContent = translateUi("本次回复已达到输出上限，可发送消息要求继续。"); body.appendChild(notice);
        } else if (message.errorMessage || message.stopReason === 'error') {
            const error = document.createElement('div');
            error.className = 'pi-inline-error';
            error.textContent = message.errorMessage || translateUi("回复失败");
            body.appendChild(error);
        }
        article.appendChild(body);
        if (responseText && showReplyActions) {
            const actions = document.createElement('footer');
            actions.className = 'pi-message-actions';
            actions.setAttribute('aria-label', translateUi("回复操作"));
            actions.appendChild(createMessageCopy(responseText, role));
            if (window.PiReplyTts.enabled) {
                const speech = document.createElement('button'); speech.type = 'button'; speech.className = 'pi-message-action pi-message-tts';
                speech.title = translateUi("朗读回复（TTS）"); speech.setAttribute('aria-label', speech.title);
                speech.innerHTML = '<i class="fa-solid fa-volume-high" aria-hidden="true"></i>';
                window.PiReplyTts.bind(speech, { text: responseText,
                    key: JSON.stringify([state.cwd, state.session?.id, message.timestamp, responseText]) });
                actions.appendChild(speech);
            }
            if (typeof message.timestamp === 'number' || typeof message.timestamp === 'string') {
                const recordedAt = new Date(message.timestamp);
                if (Number.isFinite(recordedAt.getTime())) {
                    const time = document.createElement('time');
                    time.className = 'pi-reply-time';
                    time.dateTime = recordedAt.toISOString();
                    time.textContent = recordedAt.toLocaleTimeString(globalThis.PiI18n?.locale || 'zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
                    time.title = translateUi('消息时间：{0}', messageTimeFormat.format(recordedAt));
                    time.setAttribute('aria-label', time.title);
                    actions.appendChild(time);
                }
            }
            article.appendChild(actions);
        }
        return article;
    }

    function createThinkingBlock(text = '') {
        const details = document.createElement('details');
        details.className = 'pi-thinking-block';
        details.innerHTML = `<summary><i class="fa-solid fa-brain"></i><span>${translateUi("思考过程")}</span><i class="fa-solid fa-chevron-right"></i></summary><div class="pi-thinking-content"></div>`;
        details.querySelector('.pi-thinking-content').textContent = text;
        return details;
    }

    function createToolCallBlock(toolCall) {
        const row = document.createElement('details');
        row.className = 'pi-tool-row';
        row.dataset.toolId = toolCall.id || '';
        row.dataset.toolName = toolCall.name || '';
        row._piToolArgs = toolCall.arguments;
        row.innerHTML = `
            <summary>
                <span class="pi-tool-icon"><i class="fa-solid fa-wrench"></i></span>
                <strong>${escapeHtml(toolCall.name || 'tool')}</strong>
                <span class="pi-tool-status">${translateUi("等待结果")}</span>
                <i class="fa-solid fa-chevron-right"></i>
            </summary>
            <div class="pi-tool-detail"><pre class="pi-tool-args"></pre><pre class="pi-tool-output"></pre></div>
        `;
        row.querySelector('.pi-tool-args').textContent = formatToolArgs(toolCall.arguments);
        if (toolCall.id) {
            row.dataset.readingKey = `tool:${toolCall.id}`;
            row.dataset.detailKey = row.dataset.readingKey;
            const previous = state.toolRows.get(toolCall.id);
            if (previous) {
                row.dataset.state = previous.dataset.state || 'pending';
                row.querySelector('.pi-tool-status').textContent = previous.querySelector('.pi-tool-status').textContent;
                if (previous._piResult) setToolOutput(row, previous._piResult);
                row.open = previous.open;
            }
            state.toolRows.set(toolCall.id, row);
        }
        window.PiToolLabels?.update(row);
        return row;
    }

    function setToolOutput(row, result) {
        row._piResult = result;
        window.PiToolLabels?.update(row);
        row.querySelector('.pi-tool-output').textContent = contentToPlainText(result.content);
        window.PiToolDiff.render(row, result, copyTextToClipboard, toast);
        let images = row.querySelector('.pi-tool-images');
        const blocks = Array.isArray(result.content) ? result.content.filter(block => block.type === 'image') : [];
        if (!blocks.length && !images) return;
        if (!images) {
            images = document.createElement('div');
            images.className = 'pi-tool-images';
            row.querySelector('.pi-tool-detail').appendChild(images);
        }
        images.replaceChildren();
        for (const block of blocks) {
            if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(block.mimeType)) continue;
            const image = document.createElement('img');
            image.className = 'pi-message-image';
            image.alt = translateUi("工具输出图片");
            image.src = `data:${block.mimeType};base64,${block.data}`;
            images.appendChild(image);
        }
    }

    function createToolResultElement(message) {
        let row = state.toolRows.get(message.toolCallId);
        const existing = Boolean(row?.isConnected);
        if (!existing) {
            row = createToolCallBlock({ id: message.toolCallId, name: message.toolName });
            row.querySelector('.pi-tool-args').textContent = '';
        }
        row.dataset.state = message.isError ? 'error' : 'done';
        row.querySelector('.pi-tool-status').textContent = message.isError ? translateUi("失败") : translateUi("完成");
        setToolOutput(row, message);
        return existing ? null : row;
    }

    function createBashElement(message) {
        return window.PiShell.history(message);
    }

    function createNoticeElement(type, text) {
        const notice = document.createElement('div');
        notice.className = `pi-event-notice ${type}`;
        notice.innerHTML = `<i class="fa-solid ${type === 'compactionSummary' ? 'fa-compress' : 'fa-code-branch'}"></i><div><strong>${type === 'compactionSummary' ? translateUi("上下文已压缩") : translateUi("分支摘要")}</strong><p></p></div>`;
        notice.querySelector('p').textContent = text;
        return notice;
    }

    function formatToolArgs(args) {
        if (typeof args === 'string') return args;
        try {
            return JSON.stringify(args || {}, null, 2);
        } catch {
            return String(args || '');
        }
    }

    function contentToPlainText(content) {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.map(block => block.type === 'text' ? block.text : block.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
    }

    function finalReplyIndices(messages, tailIsRunning) {
        const replies = new Set();
        let candidate = null;
        const finish = () => {
            if (candidate !== null) replies.add(candidate);
            candidate = null;
        };
        // Commentary can be plain text too; only the last reply in a user segment gets actions.
        messages.forEach((message, index) => {
            if (message.role === 'user') finish();
            else if (message.role === 'assistant') {
                const hasTools = Array.isArray(message.content) && message.content.some(block => block.type === 'toolCall');
                candidate = !hasTools && !['toolUse', 'pending'].includes(message.stopReason) && messageText(message.content).trim() ? index : null;
            } else if (message.role === 'toolResult') candidate = null;
        });
        if (!tailIsRunning) finish();
        return replies;
    }

    function renderMessages(messages) {
        const readingPosition = transcriptScroll.capture();
        const finalReplies = finalReplyIndices(messages, state.streaming);
        const editCards = turnEdits.refresh(messages, state.streaming);
        state.toolRows.clear();
        state.liveMessage = null;
        state.lastAssistantText = '';
        elements.transcript.innerHTML = '';
        messages.forEach((message, index) => {
            const element = createMessageElement(message, finalReplies.has(index));
            if (element) elements.transcript.appendChild(element);
            if (editCards.has(index)) elements.transcript.appendChild(editCards.get(index));
        });
        if (!elements.transcript.children.length) renderEmptySession();
        shell.setMessages(messages);
        decorateCodeBlocks(elements.transcript);
        transcriptView.refresh();
        transcriptScroll.restore(readingPosition);
        workflows.decorate();
    }

    function renderEmptySession() {
        elements.transcript.innerHTML = `
            <div class="pi-empty-state session-ready">
                <div class="pi-empty-mark">π</div>
                <h2>${escapeHtml(state.session ? getSessionTitle(state.session) : 'Pi Coding Agent')}</h2>
                <p>${state.session?.assistant?.kind === 'extensions' ? escapeHtml(translateUi('描述你想完成的任务，或粘贴技能、扩展包的链接。我会先检查已有能力，再查找适合的方案。')) : state.session ? escapeHtml(state.cwd) : translateUi("选择项目会话后开始工作")}</p>
            </div>
        `;
        if (state.session?.assistant?.kind !== 'extensions') window.PiExtensions?.mountExplore(elements.transcript.querySelector('.pi-empty-state'));
        transcriptView.refresh();
    }

    function clearSessionView() {
        extensionAssistant.update(null);
        turnEdits.reset();
        state.attachmentEpoch++;
        state.attachmentReads = 0;
        state.attachmentQueue = Promise.resolve();
        $('pi-attachment-preview').close();
        autoResizeInput();
        transcriptScroll.reset();
        renderEmptySession();
        state.model = null;
        state.models = []; state.modelRefreshOp = null; state.modelRefreshPending = false; state.modelRefreshError = ''; state.modelAuthError = false;
        elements.modelGuidance.hidden = true; elements.modelRefresh.disabled = true;
        state.stats = null;
        state.streaming = false;
        elements.modelSelect.innerHTML = `<option>${translateUi("等待会话")}</option>`;
        elements.modelSelect.disabled = true;
        elements.thinkingSelect.innerHTML = `<option>${translateUi("关闭")}</option>`;
        elements.thinkingSelect.disabled = true;
        elements.input.disabled = true;
        elements.sendButton.disabled = true;
        elements.compactButton.disabled = true;
        elements.currentThreadMenu.disabled = true;
        elements.composerStatus.textContent = translateUi("未打开会话");
        updateStats(null);
        updateSessionMeta();
        setAgentState('idle', translateUi("未连接"), translateUi("等待会话"));
    }

    function decorateCodeBlocks(root) {
        root.querySelectorAll('.pi-markdown pre').forEach(pre => {
            if (pre.querySelector('.pi-code-copy')) return;
            const button = document.createElement('button');
            button.className = 'pi-code-copy';
            button.type = 'button';
            button.title = translateUi("复制代码");
            button.innerHTML = '<i class="fa-regular fa-copy"></i>';
            pre.appendChild(button);
        });
    }

    function handlePiEvent(event) {
        if (['agent_start', 'agent_settled', 'tool_execution_start', 'tool_execution_end', 'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end', 'summarization_retry_scheduled', 'summarization_retry_attempt_start', 'summarization_retry_finished'].includes(event.type)) {
            state.runtimeRevision++;
            void refreshActivity();
        }
        switch (event.type) {
            case 'gateway_session_named':
                if (event.cwd === state.cwd && event.sessionId === state.session?.id && typeof event.name === 'string') sessionNamed(state.session, event.cwd, event.name);
                break;
            case 'gateway_shell': {
                const changed = shell.value?.job?.id !== event.shell.job?.id || shell.value?.job?.status !== event.shell.job?.status;
                shell.apply(event.shell);
                if (changed) {
                    state.runtimeRevision++; void refreshActivity();
                    if (!event.shell.busy) void reconcileSession();
                }
                break;
            }
            case 'gateway_queue_modes':
                shell.applyModes(event.modes);
                break;
            case 'gateway_navigation':
                state.runtimeRevision++;
                historyView.tree.apply(event.navigation);
                void refreshActivity();
                break;
            case 'gateway_context_changed':
                historyView.changed();
                state.runtimeRevision++;
                if (Array.isArray(event.messages)) renderMessages(event.messages);
                void reconcileSession();
                void workflows.refresh(true).catch(() => {});
                break;
            case 'agent_start':
                setStreaming(true);
                setConnection('working', translateUi("Pi 正在执行"));
                setAgentState('working', translateUi("执行中"), state.model?.id || 'Pi Agent');
                break;
            case 'agent_settled':
                historyView.changed();
                setStreaming(false);
                setConnection('connected', translateUi("Pi Agent 已连接"));
                setAgentState('connected', translateUi("空闲"), state.model?.id || 'Pi Agent');
                reconcileSession();
                break;
            case 'message_start':
                startLiveMessage(event.message);
                break;
            case 'message_update':
                updateLiveMessage(event.assistantMessageEvent);
                break;
            case 'message_end':
                endLiveMessage(event.message);
                break;
            case 'tool_execution_start':
                updateToolExecution(event, 'running');
                break;
            case 'tool_execution_update':
                updateToolExecution(event, 'running');
                break;
            case 'tool_execution_end':
                updateToolExecution(event, event.isError ? 'error' : 'done');
                break;
            case 'gateway_history_changed':
                historyView.changed(event.entryId);
                break;
            case 'gateway_models':
                state.models = event.models || []; state.modelAuthError = false; state.modelRefreshError = '';
                renderModels(); setStreaming(state.streaming);
                break;
            case 'gateway_commands':
                composer.setCommands(event.commands);
                nativeContext.resourcesChanged();
                break;
            case 'extension_error':
                toast(event.error || translateUi("扩展命令执行失败"), 'error');
                break;
            case 'gateway_controls':
                nativeControls.apply(event.controls);
                break;
            case 'queue_update':
                renderQueue(event);
                break;
            case 'compaction_start':
                if (event.reason === 'manual' && state.compactDraft?.generation === state.socketGeneration) clearSubmittedComposer(state.compactDraft);
                state.compacting = true;
                state.compaction = { status: 'running', reason: event.reason };
                setStreaming(state.streaming);
                setConnection('working', translateUi("正在压缩上下文"));
                setAgentState('working', translateUi("压缩中"), state.model?.id || 'Pi Agent');
                renderCompactionStatus();
                break;
            case 'compaction_end':
                state.compacting = false;
                state.compaction = {
                    status: event.aborted ? 'cancelled' : /^Compaction failed: (Already compacted|Nothing to compact \(session too small\))$/.test(event.errorMessage || '') ? 'unchanged' : event.errorMessage || !event.result ? 'error' : 'success',
                    reason: event.reason, errorMessage: event.errorMessage,
                    tokensBefore: event.result?.tokensBefore,
                    estimatedTokensAfter: event.result?.estimatedTokensAfter,
                    willRetry: Boolean(event.willRetry)
                };
                renderCompactionStatus();
                setStreaming(state.streaming);
                setConnection(state.streaming ? 'working' : 'connected', state.streaming ? translateUi("Pi 正在执行") : translateUi("Pi Agent 已连接"));
                setAgentState(state.streaming ? 'working' : 'connected', state.streaming ? translateUi("执行中") : translateUi("空闲"), state.model?.id || 'Pi Agent');
                if (state.compaction.status === 'error' && event.errorMessage) toast(translateUi("压缩失败：{0}", event.errorMessage), 'error', 8000);
                if (event.reason === 'manual' || !state.streaming) void reconcileSession();
                else void refreshStats();
                break;
            case 'summarization_retry_scheduled':
                if (!state.compacting) break;
                state.compaction = { ...state.compaction, status: 'retrying', attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs };
                renderCompactionStatus();
                setConnection('working', translateUi("压缩摘要等待重试"));
                break;
            case 'summarization_retry_attempt_start':
                if (!state.compacting) break;
                state.compaction = { ...state.compaction, status: 'running' };
                renderCompactionStatus();
                setConnection('working', translateUi("正在重试压缩摘要"));
                break;
            case 'summarization_retry_finished':
                break;
            case 'auto_retry_start':
                appendEventNotice('retry', translateUi("请求失败，{0} 秒后进行第 {1} 次重试", Math.ceil((event.delayMs || 0) / 1000), event.attempt));
                break;
            case 'auto_retry_end':
                appendEventNotice(event.success ? 'success' : 'error', event.success ? translateUi("自动重试成功") : event.finalError || translateUi("自动重试失败"));
                break;
            case 'extension_ui_request':
                handleExtensionUi(event);
                break;
            case 'gateway_ui_resolved':
                state.pendingUi.delete(event.id);
                if (state.shownUiId === event.id) closeRequestDialog();
                renderPendingUi();
                void refreshActivity();
                break;
            case 'gateway_error':
                toast(event.error || translateUi("Pi Agent 发生错误"), 'error', 7000);
                break;
        }
    }

    function startLiveMessage(message) {
        if (!message || message.role !== 'assistant') return;
        const readingPosition = transcriptScroll.capture();
        for (const element of [...elements.transcript.children].reverse()) {
            if (element.matches('.pi-message.user')) break;
            if (element.matches('.pi-turn-edits')) { turnEdits.remove(element.dataset.editRound); element.remove(); }
            element.querySelector('.pi-message-actions')?.remove();
        }
        const article = document.createElement('article');
        article.className = 'pi-message assistant streaming';
        if (message.timestamp != null) article.dataset.messageKey = JSON.stringify([message.role, message.timestamp, '']);
        article.innerHTML = `<header><strong>Pi</strong><span class="pi-stream-label">${translateUi("生成中")}</span></header><div class="pi-message-body"></div>`;
        elements.transcript.querySelector('.pi-empty-state')?.remove();
        elements.transcript.appendChild(article);
        state.liveMessage = { article, blocks: new Map(), message };
        transcriptView.refresh();
        transcriptScroll.restore(readingPosition);
    }

    function ensureLiveBlock(index, type) {
        if (!state.liveMessage) startLiveMessage({ role: 'assistant', content: [] });
        const key = `${index}:${type}`;
        if (state.liveMessage.blocks.has(key)) return state.liveMessage.blocks.get(key);
        let block;
        if (type === 'thinking') {
            block = createThinkingBlock('');
            block.open = false;
        } else if (type === 'toolcall') {
            block = createToolCallBlock({ id: '', name: 'tool', arguments: {} });
        } else {
            block = document.createElement('div');
            block.className = 'pi-markdown';
            block.dataset.raw = '';
        }
        block.dataset.readingKey = `${state.liveMessage.article.dataset.messageKey || 'live'}:${index}`;
        if (block.tagName === 'DETAILS') block.dataset.detailKey = block.dataset.readingKey;
        state.liveMessage.article.querySelector('.pi-message-body').appendChild(block);
        state.liveMessage.blocks.set(key, block);
        return block;
    }

    function updateLiveMessage(delta) {
        if (!delta) return;
        const index = delta.contentIndex ?? 0;
        if (delta.type === 'text_delta') {
            const block = ensureLiveBlock(index, 'text');
            block.dataset.raw = `${block.dataset.raw || ''}${delta.delta || ''}`;
            block.innerHTML = renderMarkdown(block.dataset.raw);
            decorateCodeBlocks(block);
        } else if (delta.type === 'thinking_delta') {
            const block = ensureLiveBlock(index, 'thinking');
            const content = block.querySelector('.pi-thinking-content');
            content.textContent += delta.delta || '';
        } else if (delta.type === 'toolcall_start') {
            const block = ensureLiveBlock(index, 'toolcall');
            block.dataset.toolId = delta.id || '';
            block.dataset.toolName = delta.toolName || 'tool';
            window.PiToolLabels?.update(block);
            if (delta.id) state.toolRows.set(delta.id, block);
        } else if (delta.type === 'toolcall_delta') {
            const block = ensureLiveBlock(index, 'toolcall');
            const args = block.querySelector('.pi-tool-args');
            args.textContent += delta.delta || '';
        } else if (delta.type === 'toolcall_end' && delta.toolCall) {
            const block = ensureLiveBlock(index, 'toolcall');
            block.dataset.toolId = delta.toolCall.id || '';
            block.dataset.toolName = delta.toolCall.name || 'tool';
            block._piToolArgs = delta.toolCall.arguments;
            window.PiToolLabels?.update(block);
            block.querySelector('.pi-tool-args').textContent = formatToolArgs(delta.toolCall.arguments);
            if (delta.toolCall.id) state.toolRows.set(delta.toolCall.id, block);
        }
        transcriptView.schedule();
        scrollTranscript();
    }

    function endLiveMessage(message) {
        if (message?.role === 'custom') {
            if (message.display === false) return;
            const duplicate = [...elements.transcript.querySelectorAll('.pi-message.custom')].some(element => {
                const previous = element._piCustomMessage;
                if (!previous || previous.customType !== message.customType) return false;
                if (message.customType === 'pivane-agent-task-result' && typeof message.details?.deliveryId === 'string')
                    return previous.details?.deliveryId === message.details.deliveryId;
                return message.timestamp != null && previous.timestamp === message.timestamp
                    && JSON.stringify(previous.content) === JSON.stringify(message.content)
                    && JSON.stringify(previous.details) === JSON.stringify(message.details);
            });
            if (duplicate) return;
            const element = createMessageElement(message);
            if (!element) return;
            // A persisted custom message can arrive after agent_settled. Invalidate
            // older history requests and append without disturbing a draft/live reply.
            state.runtimeRevision++;
            const readingPosition = transcriptScroll.capture();
            elements.transcript.querySelector('.pi-empty-state')?.remove();
            elements.transcript.appendChild(element);
            transcriptView.refresh(); workflows.decorate();
            transcriptScroll.restore(readingPosition);
            void taskResults?.refresh();
            return;
        }
        if (message?.role === 'user') {
            const key = JSON.stringify([message.role, message.timestamp, '']);
            const duplicate = [...elements.transcript.querySelectorAll(`[data-message-key="${CSS.escape(key)}"]`)].some(element => JSON.stringify(element._piUserMessage?.content) === JSON.stringify(message.content));
            if (duplicate) return;
            const images = Array.isArray(message.content) ? message.content.filter(block => block.type === 'image') : [];
            const optimistic = [...elements.transcript.querySelectorAll('.optimistic')].find(element => element._piExpectedText === messageText(message.content) && element._piExpectedImages === JSON.stringify(images));
            const element = createMessageElement(message);
            elements.transcript.querySelector('.pi-empty-state')?.remove();
            if (optimistic) optimistic.replaceWith(element);
            else elements.transcript.appendChild(element);
            transcriptView.refresh(); workflows.decorate(); scrollTranscript();
            return;
        }
        if (message?.role === 'toolResult') {
            const row = createToolResultElement(message);
            if (row) elements.transcript.appendChild(row);
            transcriptView.refresh();
            scrollTranscript();
            return;
        }
        if (!message || message.role !== 'assistant' || !state.liveMessage) return;
        const readingPosition = transcriptScroll.capture();
        const element = createMessageElement(message);
        state.liveMessage.article.replaceWith(element);
        state.liveMessage = null;
        decorateCodeBlocks(element);
        workflows.decorate();
        transcriptView.refresh();
        transcriptScroll.restore(readingPosition);
    }

    function updateToolExecution(event, status) {
        let row = state.toolRows.get(event.toolCallId)
            || elements.transcript.querySelector(`[data-tool-id="${CSS.escape(event.toolCallId || '')}"]`);
        if (!row?.isConnected || !row.classList.contains('pi-tool-row')) {
            row = createToolCallBlock({ id: event.toolCallId, name: event.toolName, arguments: event.args });
            const host = state.liveMessage?.article.querySelector('.pi-message-body') || elements.transcript;
            host.appendChild(row);
        }
        row.dataset.state = status;
        row.querySelector('.pi-tool-status').textContent = status === 'running' ? translateUi("执行中") : status === 'error' ? translateUi("失败") : translateUi("完成");
        if (event.args) {
            row._piToolArgs = event.args;
            row.querySelector('.pi-tool-args').textContent = formatToolArgs(event.args);
        }
        if (event.toolName) row.dataset.toolName = event.toolName;
        const result = event.partialResult || event.result;
        if (result) setToolOutput(row, result);
        else window.PiToolLabels?.update(row);
        transcriptView.schedule();
        scrollTranscript();
    }

    function appendEventNotice(type, text) {
        const notice = document.createElement('div');
        notice.className = `pi-runtime-notice ${type}`;
        notice.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : type === 'retry' ? 'fa-rotate' : type === 'compaction' ? 'fa-compress' : 'fa-circle-check'}"></i><span></span>`;
        notice.querySelector('span').textContent = text;
        elements.transcript.appendChild(notice);
        scrollTranscript();
    }

    function renderQueue(event) {
        if (nativeControls.enabled) return;
        const steering = event.steering || [];
        const followUp = event.followUp || [];
        if (!steering.length && !followUp.length) {
            elements.queue.classList.add('hidden');
            elements.queue.innerHTML = '';
            return;
        }
        elements.queue.classList.remove('hidden');
        elements.queue.innerHTML = [
            ...steering.map(text => `<span><i class="fa-solid fa-turn-up"></i>${escapeHtml(truncate(text, 60))}</span>`),
            ...followUp.map(text => `<span><i class="fa-solid fa-clock"></i>${escapeHtml(truncate(text, 60))}</span>`)
        ].join('');
    }

    function closeRequestDialog() {
        if (elements.requestDialog.open) elements.requestDialog.close();
        state.shownUiId = null;
    }

    function renderPendingUi() {
        const banner = $('pi-pending-ui-banner');
        banner.classList.toggle('hidden', !state.pendingUi.size || !state.connected);
        $('pi-pending-ui-count').textContent = translateUi("{0} 项等待确认", state.pendingUi.size);
        renderActivityBadges();
        setStreaming(state.streaming);
    }

    function openPendingRequest() {
        if (!isViewingSession() || !state.pendingUi.size) return;
        const event = state.pendingUi.values().next().value;
        state.shownUiId = event.id;
        elements.requestTitle.textContent = event.title || translateUi("等待确认");
        elements.requestFields.replaceChildren();
        if (event.message) {
            const message = document.createElement('p');
            message.textContent = event.message;
            elements.requestFields.appendChild(message);
        }
        if (event.method !== 'confirm') {
            const field = document.createElement(event.method === 'select' ? 'select' : event.method === 'editor' ? 'textarea' : 'input');
            field.name = 'value';
            field.setAttribute('aria-label', event.title || translateUi("输入内容"));
            if (event.method === 'select') {
                for (const option of event.options || []) {
                    const item = document.createElement('option');
                    item.value = String(option);
                    item.textContent = String(option);
                    field.appendChild(item);
                }
            } else {
                field.value = event.prefill || '';
                field.placeholder = event.placeholder || '';
                if (event.method === 'editor') field.rows = 8;
            }
            elements.requestFields.appendChild(field);
        }
        elements.requestSubmit.disabled = event.method === 'select' && !event.options?.length;
        elements.requestCancel.disabled = false;
        elements.requestDialog.showModal();
    }

    function respondToPending(cancelled) {
        const event = state.pendingUi.get(state.shownUiId);
        if (!event || !state.connected) return closeRequestDialog();
        let response = { id: event.id };
        if (cancelled) response.cancelled = true;
        else if (event.method === 'confirm') response.confirmed = true;
        else response.value = elements.requestFields.querySelector('[name="value"]')?.value || '';
        elements.requestSubmit.disabled = true;
        elements.requestCancel.disabled = true;
        sendExtensionResponse(response);
    }

    async function handleExtensionUi(event) {
        if (event.method === 'notify') return toast(event.message || '', event.notifyType === 'error' ? 'error' : 'info');
        if (event.method === 'set_editor_text') {
            if (!state.extensionDrafts) editorSuggestions.legacy(event);
            return;
        }
        if (!['confirm', 'select', 'input', 'editor'].includes(event.method)) return;
        state.pendingUi.set(event.id, event);
        renderPendingUi();
        void refreshActivity();
        if (isViewingSession() && !elements.requestDialog.open) openPendingRequest();
    }

    async function reconcileSession() {
        const generation = state.socketGeneration;
        const revision = state.runtimeRevision;
        const sessionId = state.session?.id;
        try {
            const [messageData, stats, runtime] = await Promise.all([
                requestRpc('get_messages'),
                requestRpc('get_session_stats'),
                requestRpc('get_state')
            ]);
            if (generation !== state.socketGeneration || revision !== state.runtimeRevision || sessionId !== state.session?.id) return;
            if (!state.streaming && !runtime.isStreaming && !runtime.isCompacting) {
                renderMessages(messageData.messages || []);
                state.renderedCompletion = messageData.completion || null;
                window.PiPageNotifications?.observeCompletion(state.renderedCompletion);
                void acknowledgeRenderedReply();
            }
            updateStats(stats);
            updateRuntimeState(runtime);
            await loadSessions();
            if (generation !== state.socketGeneration || sessionId !== state.session?.id) return;
            const fresh = state.sessions.find(item => item.id === state.session?.id);
            if (fresh) state.session = fresh;
            updateSessionMeta(runtime);
            void workflows.refresh(true).catch(() => {});
            if (state.modelRefreshPending && !runtime.webOperation && !runtime.pendingMessageCount) void refreshSessionModels();
        } catch (error) {
            if (state.connected) toast(translateUi("会话同步失败：{0}", error.message), 'error');
        }
    }

    async function refreshStats() {
        if (!state.connected) return;
        const generation = state.socketGeneration;
        const revision = state.runtimeRevision;
        try {
            const stats = await requestRpc('get_session_stats');
            if (generation === state.socketGeneration && revision === state.runtimeRevision) updateStats(stats);
        } catch {}
    }

    function updateRuntimeState(runtime = {}) {
        state.model = runtime.model || state.model;
        state.thinkingLevel = runtime.thinkingLevel || state.thinkingLevel;
        state.streaming = Boolean(runtime.isStreaming);
        state.compacting = Boolean(runtime.isCompacting);
        if (Object.hasOwn(runtime, 'webNavigation')) historyView.tree.apply(runtime.webNavigation);
        if (Object.hasOwn(runtime, 'webShell')) shell.apply(runtime.webShell);
        if (Object.hasOwn(runtime, 'webQueueModes')) shell.applyModes(runtime.webQueueModes);
        if (Object.hasOwn(runtime, 'webControls')) nativeControls.apply(runtime.webControls);
        if (Object.hasOwn(runtime, 'webCompaction')) state.compaction = runtime.webCompaction;
        renderCompactionStatus();
        elements.autoCompact.checked = runtime.autoCompactionEnabled !== false;
        if (state.model) {
            elements.modelSelect.value = state.models.some(m => m.provider === state.model.provider && m.id === state.model.id) ? `${state.model.provider}|||${state.model.id}` : '';
            elements.agentDetail.textContent = `${state.model.provider}/${state.model.id}`;
        }
        if (state.thinkingLevel) elements.thinkingSelect.value = state.thinkingLevel;
        setStreaming(state.streaming);
    }

    function updateStats(stats) {
        state.stats = stats;
        const usage = stats?.contextUsage;
        const percent = usage?.percent;
        const hasUsage = Number.isFinite(percent) && Number.isFinite(usage?.tokens);
        const capacity = Number.isFinite(usage?.contextWindow) ? formatTokens(usage.contextWindow) : null;
        const fraction = hasUsage ? `${formatTokens(usage.tokens)} / ${capacity}` : capacity ? `-- / ${capacity}` : translateUi("上下文");
        elements.contextPercent.textContent = hasUsage ? `${Math.round(percent)}%` : '--';
        elements.contextTokens.textContent = fraction;
        elements.contextButton.title = hasUsage ? translateUi("会话统计") : capacity ? translateUi("压缩后用量待更新，等待下一次模型回复") : translateUi("上下文用量暂无统计");
        elements.contextFill.style.width = `${hasUsage ? Math.max(0, Math.min(100, percent)) : 0}%`;
        elements.contextFill.dataset.level = hasUsage ? percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : 'ok' : 'unknown';
        elements.contextFraction.textContent = fraction;
        renderCompactionStatus();
        elements.statInput.textContent = formatTokens(stats?.tokens?.input);
        elements.statOutput.textContent = formatTokens(stats?.tokens?.output);
        elements.statCache.textContent = formatTokens(stats?.tokens?.cacheRead);
        elements.statCost.textContent = Number.isFinite(Number(stats?.cost)) ? `$${Number(stats.cost).toFixed(3)}` : '--';
        if (stats?.totalMessages != null) elements.metaMessages.textContent = String(stats.totalMessages);
    }

    function updateSessionMeta(runtime) {
        const ephemeral = Boolean(state.session?.ephemeral);
        elements.metaName.textContent = state.session ? getSessionTitle(state.session) : '--';
        elements.metaId.textContent = state.session?.id || runtime?.sessionId || '--';
        elements.metaMessages.textContent = state.stats?.totalMessages ?? state.session?.messageCount ?? '--';
        elements.metaFile.textContent = ephemeral ? translateUi("不保存（pi --no-session）") : state.session?.path || runtime?.sessionFile || '--';
        elements.metaFile.title = ephemeral ? translateUi("临时 runtime 不创建 session 文件") : state.session?.path || runtime?.sessionFile || '';
    }

    function setStreaming(streaming) {
        state.streaming = streaming;
        nativeContext.sync();
        const compacting = state.compacting || state.compactRequested;
        const stopping = nativeControls.value?.stopping || state.controlRequested;
        const busy = state.treeBusy || state.shellBusy || streaming || compacting || stopping || state.resourceRequested || Boolean(state.modelRefreshOp);
        if (state.connected && state.shellBusy) { setConnection('working', translateUi("Shell 正在执行")); setAgentState('working', translateUi("Shell 执行中"), state.model?.id || 'Pi Agent'); }
        const cancellable = !state.modelRefreshOp && !state.treeBusy && !state.shellBusy && state.connected && !state.resourceRequested && (nativeControls.enabled ? busy : streaming && !compacting);
        elements.stopButton.classList.toggle('hidden', !cancellable);
        elements.stopButton.disabled = !state.connected || stopping;
        const stopAction = nativeControls.enabled ? compacting ? translateUi("取消压缩并取回待发文字") : translateUi("停止并取回待发文字") : translateUi("停止当前任务");
        elements.stopButton.title = state.connected ? `${stopAction}（${getSessionTitle(state.session)}）` : translateUi("等待当前会话连接");
        elements.stopButton.dataset.sessionId = state.connected ? state.session?.id || '' : '';
        elements.stopButton.setAttribute('aria-label', elements.stopButton.title);
        elements.sendButton.classList.remove('hidden');
        elements.sendButton.title = streaming ? elements.deliveryMode.value === 'follow_up' ? translateUi("发送后续消息") : translateUi("发送引导消息") : translateUi("发送");
        elements.sendButton.setAttribute('aria-label', elements.sendButton.title);
        elements.deliveryMode.classList.toggle('visible', state.connected && streaming && !compacting);
        elements.deliveryMode.disabled = !state.connected || compacting || stopping || state.resourceRequested;
        elements.input.closest('.pi-composer').dataset.running = String(state.connected && busy);
        elements.sendButton.disabled = !state.connected || compacting;
        elements.compactButton.disabled = !state.connected || busy || state.pendingUi.size > 0;
        elements.autoCompact.disabled = !state.connected || state.shellBusy;
        elements.autoRetry.disabled = !state.connected || state.shellBusy;
        elements.modelSelect.disabled = busy || !state.connected || !state.models.length;
        syncModelGuidance();
        elements.thinkingSelect.disabled = busy || !state.connected || state.thinkingLevels.length <= 1;
        elements.composerStatus.textContent = !state.connected ? translateUi("未打开会话") : state.shellBusy ? translateUi("Shell 正在执行，可继续编辑草稿；停止请使用命令卡片") : state.treeBusy ? translateUi("正在切换对话位置，请在历史页查看进度或取消") : state.resourceRequested ? translateUi("正在重新加载原生资源") : stopping ? translateUi("正在停止 / 取回，请等待确认") : compacting ? translateUi("上下文压缩中") : streaming ? translateUi("Agent 运行中：引导在本轮工具后送达，后续在任务完成后送达") : translateUi("Pi Agent 已就绪");
        historyView.sync();
        workflows.update();
        sideChat.updateParent();
        autoResizeInput();
    }

    async function takeRuntimeQueue(stop = true) {
        if (!state.connected || nativeControls.value?.stopping || state.controlRequested) return;
        if (!nativeControls.enabled) return requestRpc('abort');
        const generation = state.socketGeneration;
        state.controlRequested = true; setStreaming(state.streaming);
        try {
            const value = await requestRpc(stop ? 'stop_and_recover' : 'take_queue', {}, 150000);
            if (generation !== state.socketGeneration) return;
            nativeControls.apply(value);
            await reconcileSession();
            if (generation !== state.socketGeneration) return;
            toast(stop ? translateUi("已停止；取回文字可在运行队列中查看") : translateUi("已取回队列文字，请核对后追加到草稿"), 'success');
        } catch (error) {
            if (generation !== state.socketGeneration) return;
            toast(translateUi("{0}；请核对运行状态和取回列表，未自动重试", error.message), 'error', 8000);
            await reconcileSession();
        } finally {
            if (generation === state.socketGeneration) { state.controlRequested = false; setStreaming(state.streaming); }
        }
    }

    async function copyTextToClipboard(text) {
        if (!text) throw new Error(translateUi("没有可复制的内容"));
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return;
        }
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', '');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        if (!copied) throw new Error(translateUi("浏览器拒绝复制"));
    }

    async function copyLastResponse() {
        try {
            await copyTextToClipboard(state.lastAssistantText);
            toast(translateUi("已复制最近一条 Agent 回复"), 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    }

    async function quitRuntime() {
        if (!state.connected) return toast(translateUi("当前没有运行中的 Pi runtime"), 'error');
        const wasEphemeral = Boolean(state.session?.ephemeral);
        try {
            await requestRpc('quit_session', {}, 30000);
            disconnectSocket(true);
            if (wasEphemeral) state.session = null;
            state.streaming = false;
            elements.input.disabled = true;
            elements.sendButton.disabled = true;
            elements.compactButton.disabled = true;
            elements.modelSelect.disabled = true;
            elements.thinkingSelect.disabled = true;
            elements.currentThreadMenu.disabled = true;
            elements.composerStatus.textContent = translateUi("Pi runtime 已退出");
            setConnection('idle', translateUi("Pi runtime 已退出"));
            setAgentState('idle', translateUi("已退出"), wasEphemeral ? translateUi("临时会话已销毁") : translateUi("重新打开会话可继续"));
            renderSessions();
            updateSessionMeta();
            toast(wasEphemeral ? translateUi("临时会话已销毁") : translateUi("Pi runtime 已退出，会话记录已保留"), 'success');
            return true;
        } catch (error) {
            toast(error.message, 'error');
            return false;
        }
    }

    function clearSubmittedComposer(draft) {
        if (!draft) return;
        const current = draft.key === state.composerSessionKey ? { text: elements.input.value, files: state.attachmentFiles } : state.composerDrafts.get(draft.key);
        if (current?.text === draft.text && current.files.length === draft.files.length && current.files.every((file, index) => file === draft.files[index])) {
            if (draft.key === state.composerSessionKey) { elements.input.value = ''; clearAttachments(); composer.hide(); autoResizeInput(); }
            state.composerDrafts.delete(draft.key);
        }
    }

    async function reloadResources() {
        if (!state.connected || state.shellBusy || state.streaming || state.compacting || state.compactRequested || state.controlRequested || state.resourceRequested || state.pendingUi.size) throw new Error(translateUi("请等待当前任务与确认结束后重新加载资源"));
        const generation = state.socketGeneration;
        state.resourceRequested = true; setStreaming(state.streaming);
        try {
            const data = await requestRpc('reload_resources', {}, 150000);
            if (generation !== state.socketGeneration) return;
            composer.setCommands(data.commands); await reconcileSession();
            if (generation === state.socketGeneration) toast(translateUi("原生资源已重新加载，命令目录已更新"), 'success');
        } finally {
            if (generation === state.socketGeneration) { state.resourceRequested = false; setStreaming(state.streaming); }
        }
    }

    async function executeLocalCommand(name, args, draft) {
        if (name === 'import' || name === 'export') {
            if (!transfer.enabled) throw new Error(translateUi("当前后端尚未启用会话导入与导出"));
            if (args) throw new Error(translateUi("网页 /{0} 不接收文件路径参数，请直接输入 /{1} 后在窗口中选择", name, name));
            if (name === 'export') {
                if (!state.session || state.session.ephemeral) throw new Error(translateUi("请先打开一个已保存的线程再导出"));
                return transfer.openExport(state.session, state.cwd);
            }
            return transfer.openImport(state.cwd);
        }
        if (name === 'tree') {
            if (args) throw new Error(translateUi("请输入 /tree 后在会话树中选择位置"));
            if (!historyView.tree.enabled) throw new Error(translateUi("当前后端尚未启用会话树"));
            return historyView.open('tree');
        }
        if (name === 'templates') {
            window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'skills' } }));
            $('settings-manage-templates').focus(); return true;
        }
        if (name === 'btw') return sideChat.run(() => sideChat.open({ question: args }));
        if (name === 'copy') { await copyTextToClipboard(state.lastAssistantText); toast(translateUi("已复制最近一条 Agent 回复"), 'success'); return true; }
        if (name === 'compact') return runCompact(args, draft);
        if (name === 'quit') return quitRuntime();
        if (name === 'reload') { await reloadResources(); return true; }
        if (name === 'trust') {
            if (!state.nativeSettings) throw new Error(translateUi("当前后端尚未启用项目信任设置"));
            if (args) throw new Error(translateUi("请在项目信任窗口选择操作"));
            nativeContext.openTrust(state.cwd); return true;
        }
        if (['settings', 'login', 'logout', 'scoped-models'].includes(name)) {
            const tab = ['login', 'logout'].includes(name) ? 'providers' : name === 'scoped-models' && state.nativeSettings ? 'native' : 'models';
            window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab, ...(name === 'scoped-models' ? { setting: 'enabledModels' } : {}) } })); return true;
        }
        if (name === 'session') { sideChat.showPane('details'); return true; }
        if (name === 'resume') {
            if (innerWidth <= 900) elements.inspector.classList.remove('open');
            elements.sessionPane.classList.add('open'); setSessionSearchOpen(true); return true;
        }
        if (name === 'hotkeys') { toast(translateUi("输入 / 搜索命令、Skill 或模板，@ 搜索项目文件；↑↓ 选择，Tab/Enter 填入，Esc 关闭；加号内可添加附件或延迟发送，Shift+Enter 换行。"), 'info', 12000); return true; }
        if (!state.connected) throw new Error(translateUi("请先打开会话"));
        if (name === 'fork' || name === 'clone') {
            if (!workflows.enabled) throw new Error(translateUi("当前后端尚未支持会话分叉"));
            if (name === 'fork') await workflows.openList('history'); else await workflows.openClone(); return true;
        }
        if (name === 'new') { await createSession(); return true; }
        if (name === 'name') {
            const value = args || window.prompt(translateUi("会话名称"), getSessionTitle(state.session));
            if (value === null || !value.trim()) return false;
            if (state.session.ephemeral) throw new Error(translateUi("临时会话不保存名称"));
            await apiFetch(`/api/pi/sessions/${encodeURIComponent(state.session.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cwd: state.cwd, name: value.trim().slice(0, 160) }) });
            if (draft.key === state.composerSessionKey) { state.session.name = value.trim().slice(0, 160); updateSessionMeta(); renderSessions(); }
            return true;
        }
        if (name === 'model' || name === 'thinking') {
            if (state.shellBusy || state.streaming || state.compacting || state.resourceRequested) throw new Error(translateUi("请等待会话空闲后切换模型或思考等级"));
            if (!args) {
                if (name === 'model' && !state.models.length) { syncModelGuidance(); elements.modelSetup.focus(); toast(translateUi("请先接入聊天模型；命令草稿已保留"), 'info'); return false; }
                const select = name === 'model' ? elements.modelSelect : elements.thinkingSelect;
                select.focus(); try { select.showPicker?.(); } catch {} return true;
            }
            if (name === 'model') {
                const models = state.models.filter(m => `${m.provider}/${m.id}` === args || m.id === args);
                if (models.length !== 1) throw new Error(translateUi("请使用目录中的完整 provider/model，或不带参数打开选择器"));
                await requestRpc('set_model', { provider: models[0].provider, modelId: models[0].id });
                if (draft.generation === state.socketGeneration) {
                    state.modelAuthError = false; state.modelRefreshError = '';
                    const levels = await requestRpc('get_available_thinking_levels');
                    if (draft.generation === state.socketGeneration) { state.thinkingLevels = levels.levels; renderThinkingLevels(); }
                }
            } else {
                if (!state.thinkingLevels.includes(args)) throw new Error(translateUi("该模型不支持此思考等级，请从当前下拉框选择"));
                await requestRpc('set_thinking_level', { level: args });
            }
            if (draft.generation === state.socketGeneration) await reconcileSession(); return true;
        }
        throw new Error(translateUi("此终端命令尚未接入网页，请使用对应终端功能"));
    }

    async function sendMessage() {
        const key = state.composerSessionKey;
        if (state.shellBusy && elements.input.value.trim() !== '/quit') return toast(translateUi("Shell 正在执行，请等待命令结束后发送；/quit 可退出运行实例"), 'info');
        if (nativeControls.value?.stopping || state.controlRequested) return toast(translateUi("正在停止或取回队列，请等待状态确认"), 'info');
        if (state.submittingDrafts.has(key)) return;
        if (state.attachmentReads) return toast(translateUi("附件正在读取，请稍候"), 'info');
        if (state.treeBusy) return toast(translateUi("正在切换对话位置，请等待结果；可在历史页取消导航"), 'info');
        if (state.modelRefreshOp) return toast(translateUi("正在更新模型目录，请稍候；草稿已保留"), 'info');
        if (state.resourceRequested) return toast(translateUi("正在重新加载原生资源，请稍候"), 'info');
        const text = elements.input.value.trim();
        const hasQuotes = state.attachmentFiles.some(file => file.kind === 'quote');
        const shellInput = window.PiShell.parse(elements.input.value);
        if (hasQuotes && (shellInput || /^\/[^\s/]+(?:\s|$)/.test(text))) return toast(translateUi('请先移除引用，再执行命令'), 'info');
        if (shellInput) return sendShell(shellInput);
        const slash = text.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
        const selectedCommand = slash && state.commands.find(c => c.name === slash[1]);
        if (slash && !selectedCommand) return toast(translateUi("未找到此命令，请输入 / 查看可用命令；刚保存的模板需重新加载资源"), 'info');
        if (selectedCommand?.available === false) return toast(selectedCommand.description, 'info');
        if (selectedCommand && ['web', 'builtin'].includes(selectedCommand.source)) {
            if (state.attachmentFiles.length) return toast(translateUi("此命令不接收上传附件，请先处理附件"), 'info');
            const draft = { key, generation: state.socketGeneration, text: elements.input.value, files: [...state.attachmentFiles] };
            state.submittingDrafts.add(key); composer.hide(); autoResizeInput();
            try { if (await executeLocalCommand(slash[1], slash[2]?.trim() || '', draft)) clearSubmittedComposer(draft); }
            catch (error) { if (key === state.composerSessionKey) toast(translateUi("{0}；命令草稿已保留", error.message), 'error'); }
            finally { state.submittingDrafts.delete(key); autoResizeInput(); }
            return;
        }
        if (selectedCommand?.source === 'extension' && state.attachmentFiles.length) return toast(translateUi("扩展命令不接收上传附件，请先处理附件"), 'info');
        if (!text && !state.attachmentFiles.length) return;
        if (!state.connected) return toast(translateUi("请先打开会话"), 'error');
        if (state.modelRefreshOp) return toast(translateUi("正在更新模型目录，请稍候；草稿已保留"), 'info');
        if (selectedCommand?.source !== 'extension' && !usableSessionModel()) {
            syncModelGuidance();
            (state.models.length ? elements.modelChoose : elements.modelSetup).focus();
            return toast(state.models.length ? translateUi("请先选择已接入的模型；草稿已保留") : translateUi("请先在供应商与模型设置中完成接入；草稿已保留"), 'info');
        }
        if (state.compacting || state.compactRequested) return toast(translateUi("上下文正在压缩，请等待完成"), 'info');

        try { attachments.validateDraft(elements.input.value, state.attachmentFiles); }
        catch (error) { return toast(error.message, 'error'); }
        if (state.uncertainDrafts.has(key) && !window.confirm(translateUi("上次发送结果不确定。请先核对会话，重复发送可能重复执行任务。确认仍要发送此草稿？"))) return;
        const { message, images } = attachments.payload(selectedCommand ? elements.input.value.trimStart() : elements.input.value, state.attachmentFiles);
        if (images.length && !state.model?.input?.includes('image')) {
            return toast(translateUi("当前模型不支持图片输入，请先切换多模态模型"), 'error', 6500);
        }
        const textAttachments = state.attachmentFiles.filter(file => file.kind === 'text');
        const command = selectedCommand?.source === 'extension' ? 'prompt' : state.streaming ? elements.deliveryMode.value : 'prompt';
        const draft = { text: elements.input.value, files: [...state.attachmentFiles] };
        state.submittingDrafts.add(key);
        autoResizeInput(); workflows.update();
        composer.hide();
        const optimistic = selectedCommand ? null : appendOptimisticUser(hasQuotes ? attachments.payload(text, state.attachmentFiles.filter(file => file.kind === 'quote')).message : text || textAttachments.map(file => translateUi("附件：{0}", file.name)).join(', '), images, message);
        try {
            await requestRpc(command, { message, images }, 60000);
            state.uncertainDrafts.delete(key);
            const current = key === state.composerSessionKey ? { text: elements.input.value, files: state.attachmentFiles } : state.composerDrafts.get(key);
            if (current?.text === draft.text && current.files.length === draft.files.length && current.files.every((file, index) => file === draft.files[index])) {
                if (key === state.composerSessionKey) { elements.input.value = ''; clearAttachments(); }
                state.composerDrafts.delete(key);
            }
        } catch (error) {
            optimistic?.remove();
            if (error.errorCode === 'MODEL_AUTH_REQUIRED') { state.modelAuthError = true; syncModelGuidance(); }
            if (error.deliveryUnknown) state.uncertainDrafts.add(key);
            const notice = error.deliveryUnknown ? translateUi("发送结果不确定，草稿已保留；请先核对会话，勿直接重复发送") : translateUi("{0}；草稿已保留", error.message);
            if (key === state.composerSessionKey) appendEventNotice('error', notice);
            toast(notice, 'error', 8000);
        } finally {
            state.submittingDrafts.delete(key);
            autoResizeInput(); workflows.update();
        }
    }

    async function sendShell(input) {
        if (!state.userShell) return toast(translateUi("当前后端尚未启用 Shell，命令草稿已保留"), 'info');
        if (!state.connected || state.streaming || state.shellBusy || state.compacting || state.compactRequested || state.pendingUi.size) return toast(translateUi("请等待当前会话空闲后执行 Shell"), 'info');
        if (state.attachmentFiles.length) return toast(translateUi("Shell 命令不接收附件，请先移除或发送附件"), 'info');
        if (!input.command || input.command.length > 32768) return toast(translateUi("请输入非空命令，最多 32768 字符"), 'info');
        const draft = { key: state.composerSessionKey, generation: state.socketGeneration, text: elements.input.value, files: [...state.attachmentFiles] };
        if (state.uncertainDrafts.has(draft.key) && !window.confirm(translateUi("上次提交结果不确定。请先核对原生记录和命令状态；重复执行可能再次修改文件。仍要执行？"))) return;
        state.submittingDrafts.add(draft.key); autoResizeInput(); composer.hide();
        try {
            const value = await requestRpc('bash', input, 60000);
            state.uncertainDrafts.delete(draft.key);
            clearSubmittedComposer(draft);
            if (draft.generation === state.socketGeneration) shell.apply(value);
        } catch (error) {
            if (error.deliveryUnknown) state.uncertainDrafts.add(draft.key);
            if (draft.generation === state.socketGeneration) {
                toast(translateUi("{0}；草稿已保留{1}", error.message, error.deliveryUnknown ? translateUi("，请先核对命令状态，勿直接重复执行") : ''), 'error', 8000);
                void reconcileSession();
            }
        } finally { state.submittingDrafts.delete(draft.key); autoResizeInput(); workflows.update(); }
    }

    function appendOptimisticUser(text, images, expectedText) {
        elements.transcript.querySelector('.pi-empty-state')?.remove();
        const content = [];
        if (text) content.push({ type: 'text', text });
        content.push(...images);
        const element = createMessageElement({ role: 'user', content });
        element.classList.add('optimistic');
        element._piExpectedText = expectedText;
        element._piExpectedImages = JSON.stringify(images);
        elements.transcript.appendChild(element);
        scrollTranscript();
        return element;
    }

    function scrollTranscript() {
        transcriptScroll.update();
    }

    function autoResizeInput() {
        elements.input.style.height = 'auto';
        elements.input.style.height = `${Math.min(180, Math.max(26, elements.input.scrollHeight))}px`;
        const submitting = state.submittingDrafts.has(state.composerSessionKey);
        const pending = state.attachmentReads > 0;
        const shellInput = window.PiShell.parse(elements.input.value);
        shell.sync();
        elements.sendButton.title = shellInput ? translateUi("执行 Shell 命令") : state.streaming ? elements.deliveryMode.value === 'follow_up' ? translateUi("发送后续消息") : translateUi("发送引导消息") : translateUi("发送");
        elements.sendButton.setAttribute('aria-label', elements.sendButton.title);
        elements.sendButton.querySelector('i').className = shellInput ? 'fa-solid fa-terminal' : 'fa-solid fa-arrow-up';
        elements.sendButton.disabled = Boolean(state.modelRefreshOp) || state.treeBusy || !state.connected || (state.shellBusy && elements.input.value.trim() !== '/quit') || (shellInput && (state.streaming || state.pendingUi.size > 0)) || state.resourceRequested || nativeControls.value?.stopping || state.controlRequested || state.compacting || state.compactRequested || pending || submitting || (!elements.input.value.trim() && !state.attachmentFiles.length);
        elements.attachButton.disabled = !state.connected || submitting;
        const status = $('pi-attachment-status');
        status.textContent = pending ? translateUi("正在读取附件…") : submitting ? translateUi("正在提交消息…") : state.uncertainDrafts.has(state.composerSessionKey) ? translateUi("上次发送结果不确定，草稿已保留，请先核对会话") : '';
        status.hidden = !status.textContent;
        elements.attachments.setAttribute('aria-busy', String(pending));
    }

    function handleFiles(fileList) {
        const files = [...fileList];
        elements.fileInput.value = '';
        if (!state.connected) return toast(translateUi("请先打开会话"), 'info');
        if (state.submittingDrafts.has(state.composerSessionKey)) return toast(translateUi("请等待消息投递完成"), 'info');
        const epoch = state.attachmentEpoch;
        state.attachmentReads++;
        autoResizeInput(); workflows.update();
        // Serialize all entry points; a session switch invalidates unfinished reads.
        state.attachmentQueue = state.attachmentQueue.then(async () => {
            const errors = [];
            for (const file of files) {
                if (epoch !== state.attachmentEpoch) return;
                try {
                    if (state.attachmentFiles.length >= attachments.limits.files) throw new Error(translateUi("一次最多添加 8 个附件"));
                    if (attachments.classify(file).kind === 'image' && state.attachmentFiles.filter(item => item.kind === 'image').length >= attachments.limits.images) throw new Error(translateUi("一次最多添加 6 张图片"));
                    const item = await attachments.read(file);
                    if (epoch !== state.attachmentEpoch) return;
                    attachments.validateDraft(elements.input.value, [...state.attachmentFiles, item]);
                    state.attachmentFiles.push(item);
                    renderAttachments();
                } catch (error) {
                    if (epoch === state.attachmentEpoch) errors.push(`${file.name}: ${error.message}`);
                }
            }
            if (errors.length) toast(attachments.errorSummary(errors), 'error', 6500);
        }).finally(() => {
            if (epoch === state.attachmentEpoch) {
                state.attachmentReads--;
                autoResizeInput(); workflows.update();
            }
        });
        return state.attachmentQueue;
    }

    function renderAttachments() {
        elements.attachments.classList.toggle('hidden', !state.attachmentFiles.some(file => file.kind !== 'quote'));
        mainQuotes.replaceChildren();
        elements.attachments.innerHTML = state.attachmentFiles.filter(file => file.kind !== 'quote').map(file => `
            <div class="pi-attachment-chip" data-attachment-id="${file.id}">
                <button class="pi-attachment-open" type="button" data-preview-attachment title="${translateUi("预览附件")}" aria-label="${translateUi("预览 {0}", escapeHtml(file.name))}">${file.kind === 'image' ? `<img src="${file.preview}" alt="">` : '<span class="pi-file-mark"><i class="fa-solid fa-file-code"></i></span>'}</button>
                <span title="${escapeHtml(file.name)}"><strong>${escapeHtml(file.name)}</strong><small>${file.size == null ? translateUi("图片") : `${Math.ceil(file.size / 1024)} KB`}</small></span>
                <button type="button" data-remove-attachment title="${translateUi("移除附件")}" aria-label="${translateUi("移除附件")}"><i class="fa-solid fa-xmark"></i></button>
            </div>
        `).join('');
        for (const file of state.attachmentFiles.filter(file => file.kind === 'quote')) {
            mainQuotes.append(window.PiQuotes.card(file, () => {
                state.attachmentFiles = state.attachmentFiles.filter(item => item !== file);
                renderAttachments(); autoResizeInput(); workflows.update();
            }));
        }
    }

    function previewAttachment(file) {
        $('pi-attachment-preview-name').textContent = file.name;
        const body = $('pi-attachment-preview-content');
        const original = $('pi-attachment-original');
        body.replaceChildren();
        original.hidden = file.kind !== 'image';
        if (original._piObjectUrl) URL.revokeObjectURL(original._piObjectUrl);
        original.removeAttribute('href');
        original._piObjectUrl = null;
        if (file.kind === 'image') {
            const image = document.createElement('img'); image.src = file.preview; image.alt = file.name;
            body.appendChild(image);
            const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
            original._piObjectUrl = URL.createObjectURL(new Blob([bytes], { type: file.mimeType }));
            original.href = original._piObjectUrl;
        } else {
            const text = document.createElement('pre'); text.textContent = file.text; body.appendChild(text);
        }
        $('pi-attachment-preview').showModal();
    }

    function clearAttachments() {
        state.attachmentFiles = [];
        renderAttachments();
    }

    function renderCommandMenu() { composer.complete(); }

    async function changeModel() {
        const [provider, modelId] = elements.modelSelect.value.split('|||');
        if (!provider || !modelId) return;
        if (state.modelRefreshOp) return;
        const generation = state.socketGeneration;
        const operation = { generation, kind: 'selection' }; state.modelRefreshOp = operation;
        setStreaming(state.streaming);
        try {
            const model = await requestRpc('set_model', { provider, modelId });
            if (generation !== state.socketGeneration) return;
            state.model = model; state.modelAuthError = false; state.modelRefreshError = '';
            const [levels, runtime, stats] = await Promise.all([
                requestRpc('get_available_thinking_levels'), requestRpc('get_state'), requestRpc('get_session_stats')
            ]);
            if (generation !== state.socketGeneration) return;
            state.thinkingLevels = levels.levels || ['off'];
            renderThinkingLevels();
            updateRuntimeState(runtime);
            updateStats(stats);
            toast(translateUi("已切换到 {0}", state.model.name || state.model.id), 'success');
        } catch (error) {
            if (generation !== state.socketGeneration) return;
            toast(error.message, 'error');
            renderModels();
        } finally {
            if (state.modelRefreshOp === operation) state.modelRefreshOp = null;
            if (generation === state.socketGeneration) {
                setStreaming(state.streaming);
                if (state.modelRefreshPending) queueMicrotask(() => void refreshSessionModels());
            }
        }
    }

    async function changeThinking() {
        const level = elements.thinkingSelect.value;
        elements.thinkingSelect.disabled = true;
        try {
            await requestRpc('set_thinking_level', { level });
            state.thinkingLevel = level;
            toast(translateUi("思考等级：{0}", elements.thinkingSelect.selectedOptions[0].textContent), 'success');
        } catch (error) {
            toast(error.message, 'error');
        } finally {
            elements.thinkingSelect.disabled = state.streaming || state.compacting || !state.connected || state.thinkingLevels.length <= 1;
        }
    }

    async function runCompact(customInstructions = '', draft = null) {
        if (!state.connected || state.shellBusy || state.compacting || state.compactRequested || state.streaming || state.pendingUi.size) {
            toast(translateUi("请等待当前任务完成，或先停止任务再压缩"), 'info');
            return false;
        }
        const generation = state.socketGeneration;
        const previousCompaction = state.compaction;
        state.compactDraft = draft;
        state.compactRequested = true;
        setStreaming(state.streaming);
        try {
            await requestRpc('compact', customInstructions ? { customInstructions } : {}, 11 * 60 * 1000);
            return generation === state.socketGeneration;
        } catch (error) {
            const reported = state.compaction !== previousCompaction && ['error', 'cancelled', 'unchanged'].includes(state.compaction?.status);
            if (generation === state.socketGeneration && state.connected && !reported) {
                toast(/timed out|超时/i.test(error.message) ? translateUi("压缩等待超时，正在重新同步运行状态；后台操作可能仍在继续") : error.message, 'error', 8000);
            }
            return false;
        } finally {
            if (generation === state.socketGeneration) {
                state.compactDraft = null;
                state.compactRequested = false;
                await reconcileSession();
                setStreaming(state.streaming);
            }
        }
    }

    function renderCompactionStatus() {
        const compact = state.compaction;
        const status = compact?.status;
        let text = '';
        const reason = compact?.reason === 'manual' ? translateUi("手动压缩") : compact?.reason === 'overflow' ? translateUi("溢出恢复压缩") : translateUi("自动压缩");
        if (status === 'running') text = translateUi("{0}中", reason);
        else if (status === 'retrying') text = translateUi("{0}：{1} 秒后重试 {2}/{3}", reason, Math.ceil((compact.delayMs || 0) / 1000), compact.attempt, compact.maxAttempts);
        else if (status === 'cancelled') text = translateUi("{0}已取消", reason);
        else if (status === 'unchanged') text = translateUi("暂无新增内容需要压缩");
        else if (status === 'error') text = translateUi("{0}失败：{1}", reason, compact.errorMessage || translateUi("未返回压缩结果"));
        else if (status === 'success') {
            text = translateUi("{0}完成", reason);
            if (Number.isFinite(compact.tokensBefore)) text += translateUi("，压缩前 {0}", formatTokens(compact.tokensBefore));
            if (Number.isFinite(compact.estimatedTokensAfter)) text += translateUi("，压缩后约 {0}", formatTokens(compact.estimatedTokensAfter));
        }
        if (state.stats?.contextUsage?.tokens === null) text += translateUi("{0}当前用量待下一次回复更新", text ? '。' : '');
        elements.compactionStatus.hidden = !text;
        elements.compactionStatus.dataset.status = status || 'unknown';
        elements.compactionStatus.textContent = text;
    }

    async function toggleAutoCompaction() {
        const generation = state.socketGeneration;
        const enabled = elements.autoCompact.checked;
        elements.autoCompact.disabled = true;
        try {
            await requestRpc('set_auto_compaction', { enabled });
        } catch (error) {
            if (generation === state.socketGeneration) {
                elements.autoCompact.checked = !enabled;
                toast(error.message, 'error');
            }
        } finally {
            if (generation === state.socketGeneration) {
                try {
                    const runtime = await requestRpc('get_state');
                    if (generation === state.socketGeneration) elements.autoCompact.checked = runtime.autoCompactionEnabled !== false;
                } catch {}
                if (generation === state.socketGeneration) elements.autoCompact.disabled = !state.connected;
            }
        }
    }

    function openProjectDialog() {
        elements.projectDialog.classList.remove('hidden');
        const start = state.cwd || state.defaultProject;
        elements.projectInput.value = start || '';
        $('pi-project-scope').textContent = state.roots.includes('/') ? translateUi("选择服务器上当前用户有权限访问的目录；不是这台浏览器电脑的目录。") : translateUi("可选范围：{0}。需要其他目录时，可调整服务器的项目范围（PI_PROJECT_ROOTS）。", state.roots.join('、'));
        renderProjects();
        browseDirectories(start);
        setTimeout(() => elements.projectInput.focus(), 0);
    }

    function closeProjectDialog() {
        state.directoryRequest++;
        elements.projectDialog.classList.add('hidden');
    }

    async function browseDirectories(directory) {
        const revision = ++state.directoryRequest, draft = elements.projectInput.value;
        elements.directoryUp.disabled = true;
        try {
            const query = directory ? `?path=${encodeURIComponent(directory)}` : '';
            const data = await apiFetch(`/api/pi/directories${query}`);
            if (revision !== state.directoryRequest || elements.projectDialog.classList.contains('hidden')) return;
            state.currentDirectory = data.current;
            state.directoryParent = data.parent;
            if (elements.projectInput.value === draft) elements.projectInput.value = data.current || '';
            elements.directoryCurrent.textContent = data.current || translateUi("可选位置");
            elements.directoryUp.disabled = !data.current;
            elements.directoryUp.title = elements.directoryUp.ariaLabel = data.parent ? translateUi("上级目录") : translateUi("返回可选位置");
            elements.directoryList.innerHTML = (data.directories || []).map(item => `
                <button type="button" data-path="${escapeHtml(item.path)}"><i class="fa-solid fa-folder"></i><span>${escapeHtml(item.name)}</span><i class="fa-solid fa-chevron-right"></i></button>
            `).join('') || `<div class="pi-list-state">${translateUi("没有子目录")}</div>`;
        } catch (error) {
            if (revision !== state.directoryRequest || elements.projectDialog.classList.contains('hidden')) return;
            elements.directoryUp.disabled = !state.currentDirectory;
            toast(error.message, 'error');
        }
    }

    const threadMenu = new window.PiThreadMenu();

    function historyWorkflowItems() {
        return [
            { label: translateUi("从历史问题分叉"), icon: 'fa-code-branch', disabled: !workflows.usable(), run: () => workflows.run(() => workflows.openList('history')) },
            { label: translateUi("恢复旧版本"), icon: 'fa-clock-rotate-left', disabled: workflows.busy(), run: () => workflows.run(() => workflows.openList('versions')) }
        ];
    }
    $('pi-history-more').addEventListener('click', event => {
        threadMenu.open(event.currentTarget, historyWorkflowItems());
        threadMenu.element.setAttribute('aria-label', translateUi("历史操作"));
    });
    // A menu cannot retain actions for a different thread or a hidden inspector pane.
    new MutationObserver(() => {
        const anchor = threadMenu.anchor;
        if (anchor && (!anchor.getClientRects().length || anchor.disabled)) threadMenu.close(false);
    }).observe($('chat-tab'), { attributes: true, subtree: true, attributeFilter: ['hidden', 'class', 'disabled'] });

    function showThreadMenu(target, point, current = false) {
        const row = target.closest('[data-session-id]');
        const group = target.closest('[data-project-cwd]');
        const cwd = current ? state.cwd : row?.dataset.cwd || group?.dataset.projectCwd;
        if (!cwd) return;
        const anchor = current ? target : row?.querySelector('[data-action="menu"]') || group?.querySelector('[data-project-action="menu"]');
        const command = (label, icon, run, options = {}) => ({ label, icon, ...options,
            run: () => Promise.resolve().then(run).catch(error => toast(error.message, 'error')) });
        let items;
        if (row || current) {
            const session = current ? state.session : state.session?.ephemeral && state.session.id === row.dataset.sessionId ? state.session
                : (state.projectSessions.get(cwd) || []).find(item => item.id === row.dataset.sessionId);
            if (!session) return;
            const archived = state.archivedSessions.has(activityKey(cwd, session.id));
            const historyItems = [
                ...(historyView.tree.enabled ? [command(translateUi("会话树"), 'fa-code-branch', async () => {
                    if (cwd !== state.cwd) await selectProject(cwd);
                    if (state.session?.id !== session.id || !state.connected) await openSession(session);
                    historyView.open('tree');
                }, { disabled: session.ephemeral })] : []),
                ...(historyView.enabled ? [command(translateUi("搜索历史与书签"), 'fa-magnifying-glass', async () => {
                    if (cwd !== state.cwd) await selectProject(cwd);
                    if (state.session?.id !== session.id || !state.connected) await openSession(session);
                    historyView.open();
                }, { disabled: session.ephemeral })] : []),
                ...(transfer.enabled ? [command(translateUi("导出记录"), 'fa-download', () => transfer.openExport(session, cwd), { disabled: session.ephemeral })] : []),
                ...(current && workflows.enabled && !historyView.enabled ? historyWorkflowItems() : []),
            ];
            items = [
                ...(historyItems.length ? [{ label: translateUi('历史与记录'), icon: 'fa-clock-rotate-left', children: historyItems }] : []),
                command(translateUi("重命名"), 'fa-pen', () => renameCurrent(session, cwd), { disabled: session.ephemeral }),
                ...(titleEditor?.enabled ? [command(translateUi('重新生成标题'), 'fa-wand-magic-sparkles', () => titleEditor.open(session, cwd), { disabled: session.ephemeral })] : []),
                ...(workflows.enabled ? [command(translateUi("复制为新线程"), 'fa-code-branch', async () => {
                    if (cwd !== state.cwd) await selectProject(cwd);
                    if (state.session?.id !== session.id || !state.connected) await openSession(session);
                    await workflows.openClone();
                }, { disabled: session.ephemeral })] : []),
                ...(state.manualUnread ? [command(translateUi("标记为未读"), 'fa-envelope', () => markThreadUnread(session, cwd),
                    { disabled: session.ephemeral || state.unreadRequests.has(activityKey(cwd, session.id)) })] : []),
                { label: translateUi("复制"), icon: 'fa-copy', children: [
                    command(translateUi("线程名称"), 'fa-font', () => copyTextToClipboard(getSessionTitle(session))),
                    command(translateUi("会话 ID"), 'fa-fingerprint', () => copyTextToClipboard(session.id))
                ] },
                ...(state.archiveEnabled ? [command(archived ? translateUi('恢复线程') : translateUi('归档线程'),
                    'fa-box-archive', () => setArchive(cwd, session, !archived),
                    { disabled: session.ephemeral || state.archiveRequests.has(activityKey(cwd, session.id)) })] : []),
                command(translateUi("删除线程"), 'fa-trash', () => deleteOneSession(session, cwd), { disabled: session.ephemeral, danger: true })
            ];
        } else {
            const archived = state.archivedProjects.has(cwd);
            const moreItems = [
                ...(transfer.enabled ? [command(translateUi("导入 Pi 会话"), 'fa-file-import', () => transfer.openImport(cwd))] : []),
                ...(state.nativeSettings ? [command(translateUi("项目信任"), 'fa-shield-halved', () => nativeContext.openTrust(cwd))] : []),
                command(translateUi("复制项目路径"), 'fa-copy', () => copyTextToClipboard(cwd))
            ];
            items = [
                command(translateUi("新建线程"), 'fa-plus', async () => { if (cwd !== state.cwd) await selectProject(cwd); await createSession(); }),
                command(state.pinnedProjects.includes(cwd) ? translateUi("取消置顶") : translateUi("置顶项目"), 'fa-thumbtack', () => toggleProjectPin(cwd), { disabled: state.pinRequests.has(cwd) }),
                command(translateUi("刷新线程"), 'fa-rotate', () => loadSessions(cwd)),
                { label: translateUi("更多操作"), icon: 'fa-ellipsis', children: moreItems },
                ...(state.archiveEnabled ? [command(archived ? translateUi('恢复项目') : translateUi('归档项目'),
                    'fa-box-archive', () => setArchive(cwd, null, !archived), { disabled: state.archiveRequests.has(activityKey(cwd, '')) })] : []),
                command(translateUi("从列表移除"), 'fa-folder-minus', () => removeEmptyProject(cwd), {
                    disabled: state.visibilityRequests.has(cwd) || (state.projectSessions.get(cwd)?.length
                        ?? state.projects.find(project => project.cwd === cwd)?.sessionCount ?? 0) > 0
                        || state.cwd === cwd && Boolean(state.session)
                })
            ];
        }
        threadMenu.open(anchor, items, point);
    }

    const archiveSearchLabel = document.createElement('label');
    archiveSearchLabel.className = 'pi-archive-search';
    archiveSearchLabel.hidden = true;
    const archiveSearchInput = document.createElement('input');
    archiveSearchInput.type = 'checkbox';
    archiveSearchInput.id = 'pi-include-archived';
    archiveSearchLabel.append(archiveSearchInput, document.createTextNode(translateUi('包含已归档')));
    elements.sessionFilters.after(archiveSearchLabel);
    archiveSearchInput.addEventListener('change', () => {
        state.includeArchived = archiveSearchInput.checked;
        renderSessions();
        void handleSessionSearch().catch(error => toast(error.message, 'error'));
    });
    elements.sessionList.addEventListener('click', event => {
        const summary = event.target.closest('summary');
        const details = summary?.parentElement;
        if (!details?.matches('details[data-archive-kind]')) return;
        const opening = !details.open;
        if (details.dataset.archiveKind === 'projects') state.archiveProjectsOpen = opening;
        else if (opening) state.archiveThreadsOpen.add(details.dataset.cwd);
        else state.archiveThreadsOpen.delete(details.dataset.cwd);
    });

    elements.sessionFilters.addEventListener('click', event => {
        const filter = event.target.closest('[data-filter]')?.dataset.filter;
        if (!['all', 'work'].includes(filter) || filter === state.sessionFilter) return;
        state.recentSortSnapshot = new Map(filter === 'work'
            ? [...state.recentlyOpened].map(([key, opened]) => [key, { opened }]) : []);
        state.sessionFilter = filter;
        elements.sessionFilters.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
        renderSessions();
        void loadFilteredProjects();
    });
    elements.sessionList.addEventListener('contextmenu', event => {
        if (!event.target.closest('[data-project-cwd], [data-session-id]') || event.target.closest('input, textarea, [contenteditable]') || window.getSelection()?.toString()) return;
        event.preventDefault();
        showThreadMenu(event.target, { x: event.clientX, y: event.clientY });
    });
    elements.sessionList.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) {
            if (!event.target.closest('[data-project-cwd], [data-session-id]')) return;
            event.preventDefault();
            showThreadMenu(event.target);
        }
    });
    $('pi-review-pending-ui').addEventListener('click', openPendingRequest);
    $('pi-request-later').addEventListener('click', closeRequestDialog);
    elements.requestDialog.addEventListener('cancel', event => { event.preventDefault(); closeRequestDialog(); });
    elements.requestCancel.addEventListener('click', () => respondToPending(true));
    elements.requestForm.addEventListener('submit', event => { event.preventDefault(); respondToPending(false); });
    new MutationObserver(() => {
        if (isViewingSession()) void acknowledgeRenderedReply();
    }).observe(elements.sessionPane, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => {
        if (isViewingSession()) {
            void acknowledgeRenderedReply();
        } else { closeRequestDialog(); threadMenu.close(false); }
    }).observe($('chat-tab'), { attributes: true, attributeFilter: ['class'] });

    new MutationObserver(() => { if (isViewingSession()) void acknowledgeRenderedReply(); })
        .observe(elements.inspector, { attributes: true, attributeFilter: ['class'] });
    $('pi-import-session').addEventListener('click', () => { closeProjectDialog(); transfer.openImport(state.cwd); });
    elements.projectButton.addEventListener('click', openProjectDialog);
    elements.projectDialogClose.addEventListener('click', closeProjectDialog);
    elements.projectDialog.addEventListener('click', event => {
        if (event.target === elements.projectDialog) closeProjectDialog();
    });
    elements.projectForm.addEventListener('submit', async event => {
        event.preventDefault();
        const cwd = elements.projectInput.value.trim();
        if (!cwd) return;
        try {
            await selectProject(cwd);
        } catch (error) {
            toast(error.message, 'error');
        }
    });
    elements.showHiddenProjects.addEventListener('change', renderProjects);
    elements.projectList.addEventListener('click', event => {
        const button = event.target.closest('[data-cwd]');
        if (button) selectProject(button.dataset.cwd).catch(error => toast(error.message, 'error'));
    });
    elements.directoryList.addEventListener('click', event => {
        const button = event.target.closest('[data-path]');
        if (!button) return;
        elements.projectInput.value = button.dataset.path;
        browseDirectories(button.dataset.path);
    });
    elements.directoryUp.addEventListener('click', () => {
        if (state.currentDirectory) {
            elements.projectInput.value = state.directoryParent || '';
            browseDirectories(state.directoryParent);
        }
    });
    elements.tokenForm.addEventListener('submit', event => {
        if (window.WorkspaceAccess?.supported) return;
        event.preventDefault();
        state.token = elements.tokenInput.value.trim();
        sessionStorage.setItem('pi.web.token', state.token);
        bootstrap();
    });
    elements.tempSession.addEventListener('click', createEphemeralSession);
    elements.newSession.addEventListener('click', createSession);
    elements.refreshSessions.addEventListener('click', () => Promise.all([loadProjects(), loadSessions(), refreshActivity()]).catch(error => toast(error.message, 'error')));
    setInterval(() => void refreshActivity(), 3000);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            closeRequestDialog();
            threadMenu.close(false);
            state.activityFresh = false;
            renderActivityBadges();
        } else {
            void refreshActivity();
            void acknowledgeRenderedReply();
        }
    });
    elements.sessionSearchToggle.addEventListener('click', () => setSessionSearchOpen(elements.sessionSearchField.hidden));
    elements.sessionSearch.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || event.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        setSessionSearchOpen(false);
    });
    elements.sessionSearch.addEventListener('input', () => handleSessionSearch().catch(error => toast(error.message, 'error')));
    elements.sessionList.addEventListener('click', event => {
        const recentToggle = event.target.closest('[data-work-action="toggle-recent"]');
        if (recentToggle) {
            state.recentSessionsExpanded = !state.recentSessionsExpanded;
            renderActivityBadges();
            recentToggle.focus({ preventScroll: true });
            if (!state.recentSessionsExpanded) recentToggle.scrollIntoView({ block: 'nearest' });
            return;
        }
        const projectControl = event.target.closest('[data-project-action]');
        if (projectControl) {
            const group = projectControl.closest('[data-project-cwd]');
            const cwd = group?.dataset.projectCwd;
            if (!cwd) return;
            const projectAction = projectControl.dataset.projectAction;
            if (projectAction === 'menu') {
                showThreadMenu(projectControl);
            } else if (projectAction === 'pin') {
                void toggleProjectPin(cwd);
            } else if (projectAction === 'toggle') {
                toggleProject(cwd);
            } else if (projectAction === 'more-threads') {
                state.expandedThreadLists.add(cwd);
                renderSessions();
            } else if (projectAction === 'less-threads') {
                state.expandedThreadLists.delete(cwd);
                renderSessions();
            } else if (projectAction === 'select') {
                selectProject(cwd).catch(error => toast(error.message, 'error'));
            } else if (projectAction === 'new') {
                (async () => {
                    if (state.cwd !== cwd) await selectProject(cwd);
                    await createSession();
                })().catch(error => toast(error.message, 'error'));
            }
            return;
        }

        const item = event.target.closest('[data-session-id]');
        if (!item) return;
        const cwd = item.dataset.cwd;
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'menu') { showThreadMenu(item); return; }
        (async () => {
            if (state.cwd !== cwd) await selectProject(cwd);
            const session = state.session?.ephemeral && state.session.id === item.dataset.sessionId
                ? state.session
                : (state.projectSessions.get(cwd) || state.sessions).find(candidate => candidate.id === item.dataset.sessionId);
            if (!session) return;
            if (action === 'rename') await renameCurrent(session, cwd);
            else if (action === 'delete') await deleteOneSession(session, cwd);
            else await openSession(session);
        })().catch(error => toast(error.message, 'error'));
    });
    elements.modelSelect.addEventListener('change', changeModel);
    elements.modelRefresh.addEventListener('click', () => void refreshSessionModels());
    elements.modelSetup.addEventListener('click', () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'providers' } })));
    elements.modelChoose.addEventListener('click', () => { elements.modelSelect.focus(); try { elements.modelSelect.showPicker?.(); } catch {} });
    window.addEventListener('workspace:models-changed', () => {
        if (!state.modelCatalogSupported) return;
        state.modelRefreshPending = true;
        if ($('workspace-settings-dialog').classList.contains('hidden')) void refreshSessionModels();
    });
    window.addEventListener('workspace:settings-closed', () => { if (state.modelRefreshPending) void refreshSessionModels(); });
    elements.thinkingSelect.addEventListener('change', changeThinking);
    elements.deliveryMode.addEventListener('change', () => setStreaming(state.streaming));
    elements.sendButton.addEventListener('click', sendMessage);
    elements.stopButton.addEventListener('click', () => takeRuntimeQueue(true).catch(error => toast(error.message, 'error')));
    elements.input.addEventListener('input', () => {
        autoResizeInput();
        renderCommandMenu();
    });
    elements.input.addEventListener('keydown', event => {
        if (composer.handleKey(event)) return;
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            sendMessage();
        }
    });
    elements.fileInput.accept = attachments.accept;
    elements.attachButton.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', () => handleFiles(elements.fileInput.files));
    attachments.bindTransfers({ zone: document.querySelector('.pi-composer-wrap'), input: elements.input, onFiles: handleFiles, onError: message => toast(message, 'error') });
    for (const type of ['dragover', 'drop']) document.addEventListener(type, event => {
        if (!$('chat-tab').classList.contains('active') || !attachments.hasFiles(event.dataTransfer) || event.defaultPrevented) return;
        event.preventDefault();
        if (type === 'drop') toast(translateUi("请将文件拖入消息输入区域"), 'info');
    });
    $('pi-attachment-preview-close').addEventListener('click', () => $('pi-attachment-preview').close());
    $('pi-attachment-preview').addEventListener('close', () => {
        const original = $('pi-attachment-original');
        if (original._piObjectUrl) URL.revokeObjectURL(original._piObjectUrl);
        original._piObjectUrl = null; original.removeAttribute('href');
        $('pi-attachment-preview-content').replaceChildren();
    });
    elements.attachments.addEventListener('click', event => {
        const chip = event.target.closest('[data-attachment-id]');
        if (!chip || !event.target.closest('button')) return;
        const file = state.attachmentFiles.find(item => item.id === chip.dataset.attachmentId);
        if (event.target.closest('[data-preview-attachment]')) { if (file) previewAttachment(file); return; }
        state.attachmentFiles = state.attachmentFiles.filter(file => file.id !== chip.dataset.attachmentId);
        renderAttachments();
        autoResizeInput();
    });
    elements.autoCompact.addEventListener('change', toggleAutoCompaction);
    elements.autoRetry.addEventListener('change', () => requestRpc('set_auto_retry', { enabled: elements.autoRetry.checked }).catch(error => toast(error.message, 'error')));
    elements.compactButton.addEventListener('click', () => void runCompact());
    elements.currentThreadMenu.addEventListener('click', event => showThreadMenu(event.currentTarget, undefined, true));
    elements.toggleInspector.addEventListener('click', () => {
        if (elements.inspector.classList.contains('open') && $('pi-details-tab').getAttribute('aria-selected') === 'true') elements.inspector.classList.remove('open');
        else sideChat.showPane('details');
    });
    elements.closeInspector.addEventListener('click', () => elements.inspector.classList.remove('open'));
    elements.contextButton.addEventListener('click', () => {
        if (elements.inspector.classList.contains('open') && $('pi-details-tab').getAttribute('aria-selected') === 'true') elements.inspector.classList.remove('open');
        else sideChat.showPane('details');
    });
    elements.toggleSessions.addEventListener('click', () => {
        if (innerWidth <= 900) elements.inspector.classList.remove('open');
        elements.sessionPane.classList.toggle('open');
    });
    elements.transcript.addEventListener('click', async event => {
        const messageCopy = event.target.closest('.pi-message-copy');
        if (messageCopy) {
            try {
                await copyTextToClipboard(messageCopy._piCopyText);
                messageCopy.innerHTML = '<i class="fa-solid fa-check"></i>';
                setTimeout(() => { messageCopy.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1200);
            } catch (error) {
                toast(error.message, 'error');
            }
            return;
        }

        const button = event.target.closest('.pi-code-copy');
        if (!button) return;
        const code = button.parentElement.querySelector('code')?.textContent || '';
        try {
            await copyTextToClipboard(code);
            button.innerHTML = '<i class="fa-solid fa-check"></i>';
            setTimeout(() => { button.innerHTML = '<i class="fa-regular fa-copy"></i>'; }, 1200);
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    const extensionAssistant = window.PiExtensionAssistant.create({
        toast,
        context: () => ({ cwd: state.cwd, defaultProject: state.defaultProject }),
        async start({ cwd, scope, language, draft, canNavigate }) {
            if (state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) throw new Error(translateUi("请等待附件读取或消息投递完成"));
            const originCwd = state.cwd, originId = state.session?.id, generation = state.socketGeneration;
            const session = await apiFetch('/api/pi/extension-assistant/sessions', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, scope, language,
                    returnSessionId: originCwd === cwd && state.session && !state.session.ephemeral ? originId : null })
            });
            // Preserve the new draft even if the user navigated while creation was in flight.
            state.composerDrafts.set(JSON.stringify([session.cwd, session.id]), { text: draft, files: [] });
            const rows = state.projectSessions.get(session.cwd) || [];
            if (!rows.some(row => row.id === session.id)) rows.unshift(session);
            state.projectSessions.set(session.cwd, rows);
            if (state.cwd === session.cwd) state.sessions = rows;
            rememberProject(session.cwd); renderProjects(); renderSessions();
            if (!canNavigate() || state.cwd !== originCwd || state.session?.id !== originId || generation !== state.socketGeneration) {
                toast(translateUi('扩展助手会话已创建，可从会话列表打开。'), 'info'); return false;
            }
            if (state.cwd !== session.cwd) {
                await selectProject(session.cwd);
                if (!canNavigate() || state.cwd !== session.cwd || state.session) return false;
            }
            await openSession(session);
            return state.session?.id === session.id;
        },
        async returnTo() {
            const id = state.session?.assistant?.returnSessionId, cwd = state.cwd, generation = state.socketGeneration;
            if (!id) return;
            if (state.attachmentReads || state.submittingDrafts.has(state.composerSessionKey)) throw new Error(translateUi("请等待附件读取或消息投递完成"));
            const rows = await loadSessions(cwd);
            if (generation !== state.socketGeneration || cwd !== state.cwd) return;
            const original = rows.find(row => row.id === id);
            if (!original) throw new Error(translateUi('原会话已不存在，请从会话列表选择其他会话。'));
            await openSession(original);
        }
    });
    window.PiNativeRuntime = {
        context: () => ({ cwd: state.cwd, sessionId: state.session?.id, generation: state.socketGeneration, connected: state.connected, supported: state.nativeResources,
            systemPrompts: state.systemPrompts, busy: state.treeBusy || state.shellBusy || state.streaming || state.compacting || state.compactRequested || state.controlRequested || state.resourceRequested || state.pendingUi.size > 0 }),
        systemPrompt: async () => {
            if (!state.systemPrompts || !state.connected) throw new Error(translateUi("请先打开支持系统提示词查看的会话"));
            const generation = state.socketGeneration;
            const result = await requestRpc('get_system_prompt');
            if (generation !== state.socketGeneration) throw new Error(translateUi("线程已切换，请重新读取资源"));
            return result;
        },
        resources: async () => {
            if (!state.nativeResources || !state.connected) throw new Error(translateUi("当前会话不支持资源查看"));
            const generation = state.socketGeneration;
            const result = await requestRpc('get_native_resources');
            if (generation !== state.socketGeneration) throw new Error(translateUi("线程已切换，请重新读取资源"));
            return result;
        },
        reload: reloadResources
    };
    const nativeContext = window.PiNativeContext.create({
        apiFetch,
        context: () => ({ cwd: state.cwd, sessionId: state.session?.id, generation: state.socketGeneration, connected: state.connected,
            supported: state.nativeResources, trustSupported: state.nativeSettings, reloadSupported: state.composerTools, configurationSupported: state.runtimeConfiguration,
            busy: state.treeBusy || state.shellBusy || state.streaming || state.compacting || state.compactRequested || state.controlRequested || state.resourceRequested || state.pendingUi.size > 0 || state.attachmentReads > 0 || state.submittingDrafts.has(state.composerSessionKey) }),
        resources: () => window.PiNativeRuntime.resources(), reload: reloadResources,
        configuration: () => requestRpc('get_runtime_configuration'),
        restart: async value => {
            const generation = state.socketGeneration; state.resourceRequested = true; setStreaming(state.streaming);
            try { await requestRpc('restart_runtime', { runtimeId: value.runtimeId, expectedRevision: value.revision, confirmed: true }); }
            finally { if (generation === state.socketGeneration) { state.resourceRequested = false; setStreaming(state.streaming); } }
        }
    });
    window.addEventListener('workspace:access-locked', () => {
        state.token = ''; sideChat.disposeAll(); disconnectSocket(true); setConnection('idle', translateUi("请登录工作台"));
    });
    window.addEventListener('workspace:access-ready', () => {
        state.token = '';
        if (!accessBootstrapped) void bootstrap();
        else if (state.session && !state.session.ephemeral && !state.connected) void connectSocket(state.session).catch(() => {});
    });
    window.addEventListener('beforeunload', () => { sideChat.disposeAll(); disconnectSocket(true); });
    bootstrap();
});
