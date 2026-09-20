document.addEventListener('DOMContentLoaded', () => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const $ = id => document.getElementById(id);
    const elements = {
        toggle: $('workspace-settings-toggle'),
        dialog: $('workspace-settings-dialog'),
        close: $('workspace-settings-close'),
        nav: document.querySelector('.workspace-settings-nav'),
        panels: [...document.querySelectorAll('[data-settings-panel]')],
        editor: $('workspace-settings-editor'),
        editorTitle: $('workspace-settings-editor-title'),
        editorBody: $('workspace-settings-editor-body'),
        editorClose: $('workspace-settings-editor-close'),
        providerSearch: $('settings-provider-search'),
        providerConfigured: $('settings-provider-configured'),
        providerList: $('settings-provider-list'),
        refreshProviders: $('settings-refresh-providers'),
        addProvider: $('settings-add-provider'),
        modelSearch: $('settings-model-search'),
        modelProvider: $('settings-model-provider'),
        modelAvailable: $('settings-model-available'),
        modelList: $('settings-model-list'),
        modelResult: $('settings-model-test-result'),
        refreshModels: $('settings-refresh-models'),
        addModel: $('settings-add-model'),
        mediaAgentForm: $('settings-media-agent-form'),
        mediaAgentProvider: $('settings-media-agent-provider'),
        mediaAgentModel: $('settings-media-agent-model'),
        mediaAgentCurrent: $('settings-media-agent-current'),
        mediaAgentTest: $('settings-media-agent-test'),
        packageForm: $('settings-package-form'),
        packageSource: $('settings-package-source'),
        packageList: $('settings-package-list'),
        packageProgress: $('settings-package-progress'),
        resourceSummary: $('settings-resource-summary'),
        refreshResources: $('settings-refresh-resources'),
        skillSearch: $('settings-skill-search'),
        skillCommands: $('settings-skill-commands'),
        skillList: $('settings-skill-list'),
        skillDiagnostics: $('settings-skill-diagnostics'),
        toastRegion: $('pi-toast-region')
    };

    const catalog = $('settings-unified-catalog');
    const modelActions = elements.refreshModels.closest('.settings-header-actions');
    catalog.append(modelActions, elements.modelSearch.closest('.settings-toolbar'), elements.modelResult, elements.modelList);
    $('settings-provider-header-actions').append(elements.refreshModels);
    elements.modelSearch.closest('.settings-toolbar').append(elements.providerConfigured.closest('label'));
    elements.providerSearch.closest('.settings-toolbar').hidden = true;

    const state = {
        activeTab: 'providers',
        modelSnapshot: null,
        resourceSnapshot: null,
        loadingModels: null,
        loadingResources: null,
        modelViewKey: null,
        modelGroups: new Map(),
        modelGroupOpen: new Map(),
        modelGroupPages: new Map(),
        login: null,
        editorEpoch: 0
    };

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[char]));
    }

    function currentCwd() {
        return localStorage.getItem('pi.web.cwd') || '';
    }

    function apiHeaders(extra = {}) {
        const token = sessionStorage.getItem('pi.web.token') || '';
        return { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra };
    }

    async function apiFetch(url, options = {}) {
        const response = await (window.WorkspaceAccess?.fetch || fetch)(url, { ...options, headers: apiHeaders(options.headers || {}) });
        let data = null;
        try { data = await response.json(); } catch {}
        if (!response.ok) throw Object.assign(new Error(translateUi(data?.error || `HTTP ${response.status}`)), { status: response.status });
        return data;
    }

    function toast(message, type = 'info', timeout = 4800) {
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

    function setBusy(button, busy, label) {
        if (!button) return;
        if (busy) {
            button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>${label ? ` ${escapeHtml(label)}` : ''}`;
        } else {
            button.disabled = false;
            if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }
    }

    window.addEventListener('workspace:access-ready', () => { state.modelSnapshot = null; state.resourceSnapshot = null; });
    const auxiliaryModels = window.PiAuxiliaryModels?.create({ apiFetch, saved: snapshot => {
        if (!state.modelSnapshot) return;
        state.modelSnapshot.auxiliaryModels = snapshot;
        for (const purpose of snapshot.purposes) {
            const key = purpose.id === 'session-title' ? 'sessionTitles' : purpose.id === 'media-planner' ? 'mediaAgent' : null;
            if (key) state.modelSnapshot.preferences[key] = purpose.settings;
        }
    } });
    const titleSettings = window.PiTitleSettings?.create({ apiFetch, saved: settings => {
        if (state.modelSnapshot) state.modelSnapshot.preferences.sessionTitles = settings;
    } });
    const usagePanel = window.PiUsage.create({ apiFetch });
    window.PiExtensions?.connect?.({ apiFetch, currentCwd });
    const nativeSettings = window.PiNativeSettings.create({ apiFetch, currentCwd, toast });
    const updatesPanel = window.PiUpdates.create({ apiFetch });
    const subagentSettings = window.PiSubagentSettings.create({ apiFetch, currentCwd });
    const systemPrompts = window.PiSystemPrompts.create({ apiFetch, currentCwd });

    let settingsOpener;
    function openSettings(tab = state.activeTab) {
        if (elements.dialog.classList.contains('hidden')) settingsOpener = document.activeElement;
        elements.dialog.classList.remove('hidden');
        switchTab(tab);
        elements.close.focus({ preventScroll: true });
    }

    function closeSettings() {
        window.WorkspaceAccess?.closeSettings();
        nativeSettings.close();
        usagePanel.close();
        updatesPanel.close();
        systemPrompts.close();
        subagentSettings.close();
        closeEditor();
        elements.dialog.classList.add('hidden');
        if (settingsOpener?.isConnected && settingsOpener.getClientRects().length) settingsOpener.focus({ preventScroll: true });
        window.dispatchEvent(new CustomEvent('workspace:settings-closed'));
    }

    function switchTab(tab) {
        window.PiExtensions?.setView(tab);
        state.activeTab = tab;
        if (tab === 'media') void subagentSettings.open();
        else subagentSettings.close();
        if (tab === 'access') window.WorkspaceAccess?.openSettings();
        else window.WorkspaceAccess?.closeSettings();
        void nativeSettings.open(tab);
        if (tab === 'system-prompts') void systemPrompts.open();
        else systemPrompts.close();
        if (tab === 'usage') usagePanel.open();
        else usagePanel.close();
        if (tab === 'updates') updatesPanel.open();
        else updatesPanel.close();
        elements.nav.querySelectorAll('[data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === tab));
        elements.panels.forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === tab));
        if (tab === 'providers' || tab === 'models') loadModels().then(snapshot => {
            if (auxiliaryModels?.acceptSnapshot(snapshot)) {
                if (tab === 'models') return auxiliaryModels.refresh();
            } else {
                titleSettings?.setSnapshot(snapshot);
                if (tab === 'models') return titleSettings?.refresh();
            }
        }).catch(error => showPanelError(tab, error));
        if (tab === 'packages' || tab === 'skills') loadResources().catch(error => showPanelError(tab, error));
    }

    function showPanelError(tab, error) {
        const target = tab === 'providers' ? elements.modelList
            : tab === 'models' ? elements.modelList
                : tab === 'packages' ? elements.packageList : elements.skillList;
        target.innerHTML = `<div class="settings-empty error"><i class="fa-solid fa-circle-exclamation"></i><span>${escapeHtml(error.message)}</span></div>`;
    }

    async function loadModels(force = false) {
        if (state.modelSnapshot && !force) {
            renderProviders();
            renderModels();
            return state.modelSnapshot;
        }
        if (state.loadingModels && !force) return state.loadingModels;
        elements.providerList.innerHTML = `<div class="pi-list-state"><span class="pi-spinner"></span>${translateUi("正在读取 Provider")}</div>`;
        elements.modelList.innerHTML = `<div class="pi-list-state"><span class="pi-spinner"></span>${translateUi("正在读取模型目录")}</div>`;
        const loading = apiFetch('/api/pi/settings/models')
            .then(snapshot => {
                if (state.loadingModels !== loading) return snapshot;
                state.modelSnapshot = snapshot;
                if (force) window.dispatchEvent(new CustomEvent('workspace:models-changed'));
                populateModelProviderFilter();
                populateMediaAgentControls();
                renderProviders();
                renderModels();
                return snapshot;
            })
            .finally(() => { if (state.loadingModels === loading) state.loadingModels = null; });
        state.loadingModels = loading;
        return loading;
    }

    function customProvider(id) {
        return state.modelSnapshot?.customProviders?.find(item => item.id === id);
    }

    function authSourceLabel(provider) {
        const labels = {
            stored: 'Pi credential store',
            environment: provider.authLabel || translateUi("环境变量"),
            models_json_key: 'models.json',
            models_json_command: 'models.json command',
            fallback: translateUi("Provider 配置"),
            runtime: translateUi("临时 Key")
        };
        return labels[provider.authSource] || provider.authSource || translateUi("未配置");
    }

    function renderProviders() {
        // Provider identity, auth and model rows share one catalog below.
    }

    function providerControls(provider) {
        const custom = customProvider(provider.id);
        const methods = provider.authMethods || {};
        return `<article class="settings-row provider-row" data-provider-id="${escapeHtml(provider.id)}">
            <span class="settings-status-dot ${provider.configured ? 'ok' : ''}"></span>
            <div class="settings-row-main">
                <div class="settings-row-title"><strong>${provider.configured ? translateUi("已配置") : translateUi("尚未连接")}</strong><span class="settings-badge">${custom?.api ? translateUi("自定义配置") : translateUi("Pi 内置")}</span></div>
                <div class="settings-row-meta"><span>${escapeHtml(authSourceLabel(provider))}</span><span>${escapeHtml([methods.apiKey ? 'API Key' : '', methods.oauth ? 'OAuth' : ''].filter(Boolean).join(' · ') || translateUi("使用服务器环境认证"))}</span></div>
            </div>
            <div class="settings-row-actions">
                ${methods.apiKeyLogin ? `<button type="button" data-action="key"><i class="fa-solid fa-key"></i> ${translateUi("API Key 配置")}</button>` : ''}
                ${methods.oauth && state.modelSnapshot.providerLogin ? `<button type="button" data-action="oauth">${escapeHtml(methods.oauthLabel || translateUi("OAuth 登录"))}</button>` : ''}
                ${provider.storedCredential ? `<button type="button" data-action="logout">${translateUi("移除凭据")}</button>` : ''}
                ${custom?.api ? `<button type="button" data-action="edit" aria-label="${translateUi("编辑供应商")}">${translateUi("编辑供应商")}</button><button type="button" data-action="add-model">${translateUi("添加模型")}</button><button type="button" class="danger" data-action="delete">${translateUi("删除配置")}</button>` : ''}
            </div>
        </article>`;
    }

    function populateModelProviderFilter() {
        const previous = elements.modelProvider.value;
        const providers = state.modelSnapshot.providers;
        elements.modelProvider.innerHTML = `<option value="">${translateUi("全部 Provider")}</option>` + providers.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
        if ([...elements.modelProvider.options].some(option => option.value === previous)) elements.modelProvider.value = previous;
    }

    function getMediaAgentModels(providerId = elements.mediaAgentProvider.value) {
        if (!state.modelSnapshot) return [];
        return state.modelSnapshot.models.filter(model => model.available && model.provider === providerId && !/:batch$/.test(model.id));
    }

    function populateMediaAgentModelSelect(preferredModelId = '') {
        const models = getMediaAgentModels();
        elements.mediaAgentModel.innerHTML = models.map(model => `<option value="${escapeHtml(model.id)}">${escapeHtml(model.name || model.id)}</option>`).join('');
        if (models.some(model => model.id === preferredModelId)) elements.mediaAgentModel.value = preferredModelId;
        if (!elements.mediaAgentModel.value && models[0]) elements.mediaAgentModel.value = models[0].id;
        elements.mediaAgentModel.disabled = !models.length;
    }

    function populateSessionTitleControls() {
        titleSettings?.setSnapshot(state.modelSnapshot);
    }

    function populateMediaAgentControls() {
        if (!state.modelSnapshot) return;
        if (auxiliaryModels?.acceptSnapshot(state.modelSnapshot)) return;
        populateSessionTitleControls();
        const current = state.modelSnapshot.preferences.mediaAgent || { provider: '', modelId: '' };
        const providers = state.modelSnapshot.providers
            .filter(provider => state.modelSnapshot.models.some(model => model.available && model.provider === provider.id && !/:batch$/.test(model.id)))
            .sort((a, b) => a.name.localeCompare(b.name));
        elements.mediaAgentProvider.innerHTML = providers.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join('');
        if (providers.some(provider => provider.id === current.provider)) elements.mediaAgentProvider.value = current.provider;
        if (!elements.mediaAgentProvider.value && providers[0]) elements.mediaAgentProvider.value = providers[0].id;
        populateMediaAgentModelSelect(current.modelId);
        elements.mediaAgentCurrent.textContent = current.provider && current.modelId ? `${current.provider}/${current.modelId}` : translateUi("跟随 Pi 默认模型");
    }

    async function saveMediaAgentModel(button) {
        const provider = elements.mediaAgentProvider.value;
        const modelId = elements.mediaAgentModel.value;
        if (!provider || !modelId) return toast(translateUi("没有可用的模块 Agent 模型"), 'error');
        setBusy(button, true, translateUi("保存"));
        try {
            const result = await apiFetch('/api/pi/settings/media-agent', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ provider, modelId })
            });
            state.modelSnapshot.preferences.mediaAgent = result.mediaAgent;
            elements.mediaAgentCurrent.textContent = `${provider}/${modelId}`;
            toast(translateUi("模块 Agent 模型已更新"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    function formatTokens(value) {
        const number = Number(value);
        if (!Number.isFinite(number)) return '--';
        if (number >= 1000000) return `${(number / 1000000).toFixed(1)}M`;
        if (number >= 1000) return `${Math.round(number / 1000)}k`;
        return String(number);
    }

    const MODEL_PAGE_SIZE = 20;

    function renderModels() {
        if (!state.modelSnapshot) return;
        const query = elements.modelSearch.value.trim().toLowerCase();
        const providerFilter = elements.modelProvider.value;
        const availableOnly = elements.modelAvailable.checked;
        const viewKey = JSON.stringify([query, providerFilter, availableOnly, elements.providerConfigured.checked]);
        if (viewKey !== state.modelViewKey) {
            state.modelViewKey = viewKey;
            state.modelGroupOpen.clear();
            state.modelGroupPages.clear();
        }
        const eligibleProviders = state.modelSnapshot.providers.filter(provider => (!elements.providerConfigured.checked || provider.configured) && (!providerFilter || provider.id === providerFilter));
        const eligibleIds = new Set(eligibleProviders.map(provider => provider.id));
        const providerMatches = new Set(eligibleProviders.filter(provider => `${provider.id} ${provider.name}`.toLowerCase().includes(query)).map(provider => provider.id));
        const models = state.modelSnapshot.models.filter(model => {
            if (!eligibleIds.has(model.provider)) return false;
            if (availableOnly && !model.available) return false;
            return !query || providerMatches.has(model.provider) || `${model.provider} ${model.id} ${model.name}`.toLowerCase().includes(query);
        });
        state.modelGroups = new Map();
        for (const provider of eligibleProviders) {
            if ((!query || providerMatches.has(provider.id)) && !availableOnly) state.modelGroups.set(provider.id, []);
        }
        for (const model of models) {
            if (!state.modelGroups.has(model.provider)) state.modelGroups.set(model.provider, []);
            state.modelGroups.get(model.provider).push(model);
        }
        if (!state.modelGroups.size) {
            elements.modelList.innerHTML = `<div class="settings-empty">${translateUi("没有匹配的供应商或模型；可以关闭“仅可用 / 仅已配置”筛选。")}</div>`;
            return;
        }
        const providerNames = new Map(state.modelSnapshot.providers.map(provider => [provider.id, provider.name || provider.id]));
        const configured = new Set(eligibleProviders.filter(provider => provider.configured).map(provider => provider.id));
        const providers = [...state.modelGroups.keys()].sort((a, b) => Number(configured.has(b)) - Number(configured.has(a)) || (providerNames.get(a) || a).localeCompare(providerNames.get(b) || b));
        elements.modelList.innerHTML = `
            <div class="settings-list-caption">${translateUi("{0} 个 Provider · {1} 个模型", providers.length, models.length)}</div>
            ${providers.map(provider => {
                const open = state.modelGroupOpen.get(provider) ?? Boolean(query || providerFilter);
                const name = providerNames.get(provider) || provider;
                return `<details class="settings-model-group" ${open ? 'open' : ''}>
                    <summary data-provider="${escapeHtml(provider)}">
                        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
                        <span class="settings-model-group-name"><strong>${escapeHtml(name)}</strong>${name !== provider ? `<small>${escapeHtml(provider)}</small>` : ''}</span>
                        <span class="settings-model-group-count">${translateUi("{0}{1} 个模型", configured.has(provider) ? translateUi("已配置 · ") : '', state.modelGroups.get(provider).length)}</span>
                    </summary>
                    ${providerControls(state.modelSnapshot.providers.find(item => item.id === provider))}
                    <div class="settings-provider-models"></div>
                </details>`;
            }).join('')}`;
        for (const group of elements.modelList.querySelectorAll('.settings-model-group[open]')) renderModelGroup(group);
    }

    function renderModelGroup(group) {
        const provider = group.querySelector('summary').dataset.provider;
        const models = state.modelGroups.get(provider) || [];
        const pages = Math.max(1, Math.ceil(models.length / MODEL_PAGE_SIZE));
        const page = Math.min(state.modelGroupPages.get(provider) || 0, pages - 1);
        state.modelGroupPages.set(provider, page);
        const visible = models.slice(page * MODEL_PAGE_SIZE, (page + 1) * MODEL_PAGE_SIZE);
        const editableIds = new Set(customProvider(provider)?.models.map(model => model.id) || []);
        const defaults = state.modelSnapshot.preferences;
        group.querySelector('.settings-provider-models').innerHTML = visible.map(model => {
            const isDefault = defaults.defaultProvider === model.provider && defaults.defaultModel === model.id;
            const editable = editableIds.has(model.id);
            return `
                <article class="settings-row model-row" data-provider-id="${escapeHtml(model.provider)}" data-model-id="${escapeHtml(model.id)}">
                    <span class="settings-model-icon"><i class="fa-solid ${model.input.includes('image') ? 'fa-eye' : 'fa-font'}"></i></span>
                    <div class="settings-row-main">
                        <div class="settings-row-title"><strong title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</strong>${isDefault ? `<span class="settings-badge primary">${translateUi("默认")}</span>` : ''}${model.reasoning ? '<span class="settings-badge">Reasoning</span>' : ''}</div>
                        <div class="settings-row-meta"><code title="${escapeHtml(`${model.provider}/${model.id}`)}">${escapeHtml(`${model.provider}/${model.id}`)}</code><span>${formatTokens(model.contextWindow)} context</span><span>${model.input.includes('image') ? translateUi("文本 + 图片") : translateUi("文本")}</span></div>
                        <div class="settings-row-meta"><span>${model.available ? translateUi("可用") : translateUi("未认证")}</span>${model.thinkingLevels ? `<span>Thinking: ${escapeHtml(model.thinkingLevels.join(' / '))}</span><span>${translateUi("默认: {0}", escapeHtml(defaults.modelThinkingLevels?.[`${model.provider}/${model.id}`] || translateUi("跟随全局")))}</span>` : ''}</div>
                    </div>
                    <div class="settings-row-actions">
                        ${state.modelSnapshot.modelThinking ? '<button type="button" data-action="thinking">Thinking</button>' : ''}
                        <button type="button" data-action="test" ${model.available ? '' : 'disabled'}><i class="fa-solid fa-vial"></i> ${translateUi("测试")}</button>
                        ${isDefault ? '' : `<button type="button" data-action="default"><i class="fa-solid fa-star"></i> ${translateUi("设为默认")}</button>`}
                        ${editable ? `<button type="button" data-action="edit" aria-label="${translateUi("编辑模型")}"><i class="fa-solid fa-pen"></i></button><button type="button" class="danger" data-action="delete" aria-label="${translateUi("删除模型")}"><i class="fa-solid fa-trash"></i></button>` : ''}
                    </div>
                </article>`;
        }).join('') + (!models.length ? `<p class="settings-empty">${translateUi("此供应商暂无匹配模型。完成连接后可点击“刷新目录”。")}</p>` : '') + (pages > 1 ? `
            <div class="settings-model-pagination" role="group" aria-label="${translateUi("模型分页")}">
                <button class="settings-secondary-button" type="button" data-model-page="previous" ${page === 0 ? 'disabled' : ''}>${translateUi("上一页")}</button>
                <span>${translateUi("{0} / {1} 页 · {2} 项", page + 1, pages, models.length)}</span>
                <button class="settings-secondary-button" type="button" data-model-page="next" ${page === pages - 1 ? 'disabled' : ''}>${translateUi("下一页")}</button>
            </div>` : '');
    }

    async function openProviderLogin(providerId, method) {
        const provider = state.modelSnapshot.providers.find(item => item.id === providerId);
        openEditor(`${provider?.name || providerId} · ${method === 'oauth' ? translateUi("OAuth 登录") : translateUi("API Key 配置")}`, `
            <div class="settings-form settings-login">
                <p>${translateUi("按 Pi 提供的步骤完成连接，凭据由 Pi 保存。关闭此窗口会取消尚未完成的登录。")}</p>
                ${method === 'oauth' ? `<p>${translateUi("在手机或其他电脑上授权时，localhost 回调可能无法打开；可将地址栏中的完整回调地址粘贴到下方 Pi 提供的输入框。")}</p>` : ''}
                <div id="settings-login-status" role="status" aria-live="polite">${translateUi("正在启动登录…")}</div>
                <div id="settings-login-events"></div><div id="settings-login-prompts"></div>
                <p id="settings-login-error" role="alert"></p>
                <button type="button" class="settings-secondary-button" data-editor-cancel>${translateUi("取消 / 关闭")}</button>
            </div>`);
        const login = { id: null, revision: -1, timer: null, finished: false };
        state.login = login;
        try {
            const result = await apiFetch(`/api/pi/settings/providers/${encodeURIComponent(providerId)}/login`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method })
            });
            login.id = result.id;
            if (state.login !== login) {
                await apiFetch(`/api/pi/settings/login/${encodeURIComponent(login.id)}`, { method: 'DELETE' }); return;
            }
            updateLogin(login, result);
            pollLogin(login);
        } catch (error) {
            if (state.login === login) $('settings-login-error').textContent = translateUi("{0}。若连接中断，未完成的登录最多保留 10 分钟后失效。", error.message);
        }
    }

    function updateLogin(login, snapshot) {
        if (state.login !== login || snapshot.revision < login.revision) return;
        login.finished = snapshot.finished;
        if (snapshot.revision === login.revision) return;
        login.revision = snapshot.revision;
        const labels = { starting: translateUi("正在启动…"), waiting: translateUi("请完成下面的授权步骤"), cancelling: translateUi("正在取消，请核对最终凭据状态"), success: translateUi("连接成功，凭据已保存"), committed: translateUi("凭据已保存，请刷新检查"), cancelled: translateUi("登录已取消"), expired: translateUi("登录已过期"), error: translateUi("登录未完成") };
        $('settings-login-status').textContent = translateUi(snapshot.message || labels[snapshot.status] || snapshot.status);
        const events = $('settings-login-events');
        events.replaceChildren();
        const link = (parent, url, label) => {
            try {
                const parsed = new URL(url);
                if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return;
                const anchor = document.createElement('a'); anchor.href = parsed.href; anchor.textContent = label || translateUi("打开授权页面");
                anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; parent.append(anchor);
            } catch {}
        };
        for (const event of snapshot.events || []) {
            const item = document.createElement('p');
            if (event.type === 'auth_url') { item.textContent = event.instructions || ''; link(item, event.url); }
            else if (event.type === 'device_code') {
                const code = document.createElement('strong'); code.textContent = event.userCode;
                item.append(translateUi("设备授权码："), code, ' '); link(item, event.verificationUri, translateUi("打开设备授权页面"));
            } else { item.textContent = event.message || ''; for (const info of event.links || []) link(item, info.url, info.label); }
            events.append(item);
        }
        const prompts = $('settings-login-prompts');
        const pendingIds = new Set((snapshot.prompts || []).map(prompt => prompt.id));
        for (const form of prompts.children) if (!pendingIds.has(form.dataset.promptId)) form.remove();
        for (const prompt of snapshot.prompts || []) {
            if ([...prompts.children].some(form => form.dataset.promptId === prompt.id)) continue;
            const form = document.createElement('form'); form.className = 'settings-form'; form.dataset.promptId = prompt.id;
            const label = document.createElement('label'); const title = document.createElement('span'); title.textContent = prompt.message;
            const field = document.createElement(prompt.type === 'select' ? 'select' : 'input');
            field.name = 'answer'; field.autocomplete = 'off';
            if (prompt.type === 'select') {
                for (const option of prompt.options) { const node = document.createElement('option'); node.value = option.id; node.textContent = option.label; field.append(node); }
            } else field.type = prompt.type === 'secret' || prompt.type === 'manual_code' ? 'password' : 'text';
            label.append(title, field);
            const submit = document.createElement('button'); submit.type = 'submit'; submit.className = 'settings-primary-button'; submit.textContent = translateUi("继续");
            form.append(label, submit); prompts.append(form);
            form.addEventListener('submit', async event => {
                event.preventDefault(); if (submit.disabled) return;
                const value = field.value; field.value = ''; submit.disabled = true;
                try {
                    const result = await apiFetch(`/api/pi/settings/login/${encodeURIComponent(login.id)}/answer`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ promptId: prompt.id, value })
                    });
                    if (state.login === login) { $('settings-login-error').textContent = ''; updateLogin(login, result); }
                } catch (error) {
                    if (state.login === login) $('settings-login-error').textContent = translateUi("{0}；请等待状态更新，或取消后核对凭据。不会自动重复提交。", error.message);
                }
            });
            if (prompts.children.length === 1) field.focus({ preventScroll: true });
        }
        if (snapshot.finished) {
            clearTimeout(login.timer);
            state.modelSnapshot = null;
            loadModels(true).catch(error => toast(error.message, 'error'));
        }
    }

    function pollLogin(login) {
        if (state.login !== login || login.finished) return;
        login.timer = setTimeout(async () => {
            try {
                const snapshot = await apiFetch(`/api/pi/settings/login/${encodeURIComponent(login.id)}`);
                updateLogin(login, snapshot);
            } catch (error) {
                if (state.login === login) $('settings-login-error').textContent = translateUi("暂时无法读取登录状态：{0}", error.message);
            }
            pollLogin(login);
        }, 750);
    }

    function openThinkingEditor(provider, modelId) {
        const snapshot = state.modelSnapshot;
        const model = snapshot.models.find(item => item.provider === provider && item.id === modelId);
        const current = snapshot.preferences.modelThinkingLevels?.[`${provider}/${modelId}`] || '';
        const keys = snapshot.thinkingMapKeys || [];
        openEditor(`${model.name} · Thinking`, `
            <form id="settings-thinking-default-form" class="settings-form">
                <p>${translateUi("可用等级：{0}。默认值用于新的会话；恢复已有会话时保留其思考状态。", escapeHtml(model.thinkingLevels.join(' / ')))}</p>
                <label><span>${translateUi("此模型默认思考等级")}</span><select name="level"><option value="">${translateUi("跟随全局（{0}）", escapeHtml(snapshot.preferences.defaultThinkingLevel || translateUi("Pi 默认")))}</option>${model.thinkingLevels.map(level => `<option value="${escapeHtml(level)}">${escapeHtml(level)}</option>`).join('')}</select></label>
                <button class="settings-primary-button" type="submit">${translateUi("保存默认值")}</button>
            </form>
            <details class="settings-thinking-advanced"><summary>${translateUi("高级：模型支持的等级与参数映射")}</summary>
                <p>${translateUi("仅按实际服务能力修改。禁用的等级将从 Pi 选择器隐藏；映射值会传给供应商。保存能力后重新打开窗口选择默认值。")}</p>
                <form id="settings-thinking-map-form" class="settings-form">
                    ${keys.map(level => `<div class="settings-thinking-map-row" data-level="${escapeHtml(level)}"><label><span>${escapeHtml(level)}</span><select aria-label="${translateUi("{0} 支持方式", escapeHtml(level))}"><option value="inherit">${translateUi("使用 Pi 定义")}</option><option value="disabled">${translateUi("不支持")}</option><option value="mapped">${translateUi("自定义映射")}</option></select></label><label><span>${translateUi("供应商参数值")}</span><input aria-label="${translateUi("{0} 参数值", escapeHtml(level))}" maxlength="100"></label></div>`).join('')}
                    <div class="settings-form-actions"><button type="button" id="settings-thinking-reset">${translateUi("恢复 Pi 原始能力")}</button><button class="settings-primary-button" type="submit">${translateUi("保存能力")}</button></div>
                </form>
            </details><p id="settings-thinking-error" role="alert"></p>`);
        const epoch = state.editorEpoch;
        const form = $('settings-thinking-default-form');
        form.elements.level.value = model.thinkingLevels.includes(current) ? current : '';
        const mapForm = $('settings-thinking-map-form');
        for (const row of mapForm.querySelectorAll('[data-level]')) {
            const value = model.thinkingLevelMap[row.dataset.level];
            row.querySelector('select').value = value === null ? 'disabled' : typeof value === 'string' ? 'mapped' : 'inherit';
            row.querySelector('input').value = typeof value === 'string' ? value : '';
            const sync = () => {
                const input = row.querySelector('input');
                input.disabled = row.querySelector('select').value !== 'mapped';
                input.closest('label').hidden = input.disabled;
            };
            row.querySelector('select').addEventListener('change', sync); sync();
        }
        const save = async (payload, button) => {
            const buttons = elements.editorBody.querySelectorAll('button'); buttons.forEach(item => { item.disabled = true; });
            setBusy(button, true, translateUi("保存"));
            try {
                await apiFetch('/api/pi/settings/models/thinking', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ provider, modelId, expectedRevision: snapshot.revision, ...payload }) });
                if (state.editorEpoch === epoch) closeEditor();
                state.modelSnapshot = null; await loadModels(true);
                toast(translateUi("Thinking 配置已保存；新 runtime 生效，运行中的会话保留当前状态"), 'success', 6500);
            } catch (error) {
                if (state.editorEpoch === epoch) $('settings-thinking-error').textContent = error.message;
            } finally { buttons.forEach(item => { item.disabled = false; }); setBusy(button, false); }
        };
        form.addEventListener('submit', event => { event.preventDefault(); save({ defaultThinkingLevel: form.elements.level.value || null }, form.querySelector('button')); });
        mapForm.addEventListener('submit', event => {
            event.preventDefault(); const map = {};
            for (const row of mapForm.querySelectorAll('[data-level]')) {
                const mode = row.querySelector('select').value;
                if (mode !== 'inherit') map[row.dataset.level] = mode === 'disabled' ? null : row.querySelector('input').value;
            }
            save({ thinkingLevelMap: map }, mapForm.querySelector('[type=submit]'));
        });
        $('settings-thinking-reset').addEventListener('click', event => save({ thinkingLevelMap: null }, event.currentTarget));
    }

    async function saveApiKey(providerId, apiKey, button) {
        setBusy(button, true, translateUi("保存"));
        try {
            await apiFetch(`/api/pi/settings/providers/${encodeURIComponent(providerId)}/api-key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ apiKey })
            });
            closeEditor();
            state.modelSnapshot = null;
            await loadModels(true);
            toast(translateUi("API Key 已保存到 Pi credential store；重新打开 runtime 后生效"), 'success', 6500);
        } finally {
            setBusy(button, false);
        }
    }

    function openApiKeyEditor(providerId) {
        const provider = state.modelSnapshot.providers.find(item => item.id === providerId);
        openEditor(translateUi("设置 {0} API Key", provider?.name || providerId), `
            <form id="settings-api-key-form" class="settings-form">
                <div class="settings-secret-note"><i class="fa-solid fa-shield-halved"></i><span>${translateUi("凭据由 Pi 保存，现有值不会回显。请在受信网络中配置。")}</span></div>
                <label><span>API Key</span><input id="settings-api-key-input" type="password" autocomplete="new-password" required></label>
                <div class="settings-form-actions"><button type="button" data-editor-cancel>${translateUi("取消")}</button><button class="settings-primary-button" type="submit"><i class="fa-solid fa-floppy-disk"></i> ${translateUi("保存")}</button></div>
            </form>
        `);
        const input = $('settings-api-key-input');
        const form = $('settings-api-key-form');
        setTimeout(() => input?.focus(), 0);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const key = input.value;
            input.value = '';
            try { await saveApiKey(providerId, key, form.querySelector('[type=submit]')); }
            catch (error) { toast(error.message, 'error', 7000); }
        });
    }

    async function removeCredential(providerId, button) {
        if (!confirm(translateUi("移除 Pi credential store 中这个 Provider 的凭据？环境变量或 models.json 中的配置不会被删除。"))) return;
        setBusy(button, true);
        try {
            const result = await apiFetch(`/api/pi/settings/providers/${encodeURIComponent(providerId)}/credential`, { method: 'DELETE' });
            state.modelSnapshot = null;
            await loadModels(true);
            toast(result.stillConfigured ? translateUi("已移除存储凭据；Provider 仍由 {0} 配置", result.authSource) : translateUi("凭据已移除"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    function openProviderEditor(provider) {
        const editing = Boolean(provider);
        openEditor(editing ? translateUi("编辑 {0}", provider.id) : translateUi("新增自定义 Provider"), `
            <form id="settings-provider-form" class="settings-form">
                <div class="settings-form-grid">
                    <label><span>Provider ID</span><input name="id" value="${escapeHtml(provider?.id || '')}" ${editing ? 'readonly' : ''} required pattern="[A-Za-z0-9._-]+"></label>
                    <label><span>${translateUi("API 类型")}</span><select name="api"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
                    <label class="wide"><span>Base URL</span><input name="baseUrl" type="url" value="${escapeHtml(provider?.baseUrl || '')}" placeholder="https://api.example.com/v1" required></label>
                    <label class="settings-checkbox-field"><input name="authHeader" type="checkbox" ${provider?.authHeader ? 'checked' : ''}><span>${translateUi("自动添加 Authorization: Bearer")}</span></label>
                </div>
                <div class="settings-form-actions"><button type="button" data-editor-cancel>${translateUi("取消")}</button><button class="settings-primary-button" type="submit">${translateUi("保存 Provider")}</button></div>
            </form>
        `);
        const form = $('settings-provider-form');
        form.elements.api.value = provider?.api || 'openai-completions';
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const submit = form.querySelector('[type=submit]');
            setBusy(submit, true, translateUi("保存"));
            const data = Object.fromEntries(new FormData(form));
            data.authHeader = form.elements.authHeader.checked;
            try {
                await apiFetch('/api/pi/settings/custom-providers', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
                });
                closeEditor(); state.modelSnapshot = null; await loadModels(true);
                toast(translateUi("自定义 Provider 已保存；请设置 API Key 并重新打开 runtime"), 'success', 6500);
            } catch (error) { toast(error.message, 'error'); }
            finally { setBusy(submit, false); }
        });
    }

    async function deleteProvider(providerId, button) {
        if (!confirm(translateUi("删除自定义 Provider “{0}”及其 models.json 模型配置？", providerId))) return;
        setBusy(button, true);
        try {
            await apiFetch(`/api/pi/settings/custom-providers/${encodeURIComponent(providerId)}`, { method: 'DELETE' });
            state.modelSnapshot = null; await loadModels(true); toast(translateUi("自定义 Provider 已删除"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    function openModelEditor(providerId, model) {
        const customProviders = state.modelSnapshot.customProviders || [];
        if (!customProviders.length) return toast(translateUi("请先创建自定义 Provider"), 'error');
        openEditor(model ? translateUi("编辑 {0}", model.id) : translateUi("新增自定义模型"), `
            <form id="settings-model-form" class="settings-form">
                <div class="settings-form-grid">
                    <label><span>Provider</span><select name="providerId">${customProviders.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.id)}</option>`).join('')}</select></label>
                    <label><span>Model ID</span><input name="id" value="${escapeHtml(model?.id || '')}" required maxlength="500" ${model ? 'readonly' : ''}></label>
                    <label class="wide"><span>${translateUi("显示名称")}</span><input name="name" value="${escapeHtml(model?.name || '')}" placeholder="${translateUi("默认使用 Model ID")}"></label>
                    <label><span>Context Window</span><input name="contextWindow" type="number" min="1024" max="4000000" value="${model?.contextWindow || 128000}" required></label>
                    <label><span>${translateUi("最大输出 Tokens")}</span><input name="maxTokens" type="number" min="1" max="1000000" value="${model?.maxTokens || 16384}" required></label>
                    <label class="settings-checkbox-field"><input name="reasoning" type="checkbox" ${model?.reasoning ? 'checked' : ''}><span>${translateUi("支持 reasoning")}</span></label>
                    <label class="settings-checkbox-field"><input name="imageInput" type="checkbox" ${model?.input?.includes('image') ? 'checked' : ''}><span>${translateUi("支持图片输入")}</span></label>
                </div>
                <div class="settings-form-actions"><button type="button" data-editor-cancel>${translateUi("取消")}</button><button class="settings-primary-button" type="submit">${translateUi("保存模型")}</button></div>
            </form>
        `);
        const form = $('settings-model-form');
        form.elements.providerId.value = providerId || customProviders[0].id;
        if (model) form.elements.providerId.disabled = true;
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const submit = form.querySelector('[type=submit]'); setBusy(submit, true, translateUi("保存"));
            const data = Object.fromEntries(new FormData(form));
            data.reasoning = form.elements.reasoning.checked;
            data.imageInput = form.elements.imageInput.checked;
            const targetProvider = form.elements.providerId.value;
            try {
                await apiFetch(`/api/pi/settings/custom-providers/${encodeURIComponent(targetProvider)}/models`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
                });
                closeEditor(); state.modelSnapshot = null; await loadModels(true); toast(translateUi("自定义模型已保存"), 'success');
            } catch (error) { toast(error.message, 'error'); }
            finally { setBusy(submit, false); }
        });
    }

    async function deleteModel(providerId, modelId, button) {
        if (!confirm(translateUi("删除模型 “{0}/{1}”？", providerId, modelId))) return;
        setBusy(button, true);
        try {
            await apiFetch(`/api/pi/settings/custom-providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(modelId)}`, { method: 'DELETE' });
            state.modelSnapshot = null; await loadModels(true); toast(translateUi("模型已删除"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    async function setDefaultModel(provider, modelId, button) {
        setBusy(button, true);
        try {
            await apiFetch('/api/pi/settings/models/preferences', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ defaultProvider: provider, defaultModel: modelId })
            });
            state.modelSnapshot.preferences.defaultProvider = provider;
            state.modelSnapshot.preferences.defaultModel = modelId;
            renderModels();
            toast(translateUi("默认模型已更新；新 runtime 将使用此模型"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    async function testModel(provider, modelId, button) {
        setBusy(button, true, translateUi("测试中"));
        elements.modelResult.className = 'settings-result';
        elements.modelResult.textContent = translateUi("正在测试 {0}/{1}...", provider, modelId);
        try {
            const result = await apiFetch('/api/pi/settings/models/test', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider, modelId })
            });
            elements.modelResult.className = 'settings-result success';
            elements.modelResult.innerHTML = `<strong>${translateUi("连接成功 · {0}s", (result.latencyMs / 1000).toFixed(2))}</strong><span>${escapeHtml(result.text || translateUi("(空回复)"))}</span>`;
        } catch (error) {
            elements.modelResult.className = 'settings-result error';
            elements.modelResult.innerHTML = `<strong>${translateUi("测试失败")}</strong><span>${escapeHtml(error.message)}</span>`;
        } finally { setBusy(button, false); }
    }

    async function refreshModelCatalog(button) {
        setBusy(button, true, translateUi("刷新中"));
        try {
            const result = await apiFetch('/api/pi/settings/models/refresh', { method: 'POST' });
            state.modelSnapshot = null; await loadModels(true);
            toast(result.errors.length ? translateUi("目录已刷新，{0} 个 Provider 失败", result.errors.length) : translateUi("模型目录已刷新"), result.errors.length ? 'info' : 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    async function loadResources(force = false) {
        const cwd = currentCwd();
        if (state.resourceSnapshot && state.resourceCwd === cwd && !force) {
            renderPackages(); renderSkills(); return state.resourceSnapshot;
        }
        if (state.loadingResources && state.loadingResourceCwd === cwd && !force) return state.loadingResources;
        state.resourceSnapshot = null;
        elements.packageList.innerHTML = `<div class="pi-list-state"><span class="pi-spinner"></span>${translateUi("正在解析 Packages")}</div>`;
        elements.skillList.innerHTML = `<div class="pi-list-state"><span class="pi-spinner"></span>${translateUi("正在读取 Skills")}</div>`;
        state.loadingResourceCwd = cwd;
        const loading = apiFetch(`/api/pi/settings/resources?cwd=${encodeURIComponent(cwd)}`)
            .then(snapshot => {
                if (state.loadingResources !== loading || cwd !== currentCwd()) return snapshot;
                state.resourceSnapshot = snapshot;
                state.resourceCwd = cwd;
                renderPackages(); renderSkills(); return snapshot;
            }).catch(error => {
                if (state.loadingResources === loading && cwd === currentCwd()) throw error;
                return null;
            }).finally(() => { if (state.loadingResources === loading) state.loadingResources = null; });
        state.loadingResources = loading;
        return loading;
    }

    function renderPackages() {
        if (!state.resourceSnapshot) return;
        const packages = state.resourceSnapshot.packages;
        elements.packageList.innerHTML = packages.length ? packages.map(item => `
            <article class="settings-row package-row" data-package-source="${escapeHtml(item.source)}">
                <span class="settings-model-icon"><i class="fa-solid fa-box"></i></span>
                <div class="settings-row-main"><div class="settings-row-title"><strong>${escapeHtml(item.source)}</strong>${item.filtered ? `<span class="settings-badge">${translateUi("已过滤")}</span>` : ''}</div><div class="settings-row-meta"><span>${escapeHtml(item.scope)}</span><span>${item.installed ? translateUi("已安装") : translateUi("配置存在但未安装")}</span></div></div>
                <div class="settings-row-actions"><button type="button" data-action="update"><i class="fa-solid fa-arrows-rotate"></i> ${translateUi("更新")}</button><button type="button" class="danger" data-action="remove"><i class="fa-solid fa-trash"></i> ${translateUi("删除")}</button></div>
            </article>
        `).join('') : `<div class="settings-empty">${translateUi("尚未安装 Pi Package")}</div>`;
        const resources = state.resourceSnapshot.resources;
        elements.resourceSummary.innerHTML = [
            ['Extensions', resources.extensions], ['Package Skills', resources.skills], ['Prompts', resources.prompts], ['Themes', resources.themes]
        ].map(([label, items]) => `<div><strong>${items.filter(item => item.enabled).length}</strong><span>${label}</span></div>`).join('');
    }

    async function runPackageAction(action, source, button) {
        if (action === 'remove' && !confirm(translateUi("删除 Package “{0}”？", source))) return;
        if (action === 'install' && !confirm(translateUi("安装并信任 Package “{0}”？Packages 可执行任意代码。", source))) return;
        setBusy(button, true, action === 'install' ? translateUi("安装中") : action === 'remove' ? translateUi("删除中") : translateUi("更新中"));
        elements.packageProgress.className = 'settings-result';
        elements.packageProgress.textContent = `${action}: ${source}`;
        try {
            const result = await apiFetch('/api/pi/settings/packages/action', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, source, cwd: currentCwd() })
            });
            elements.packageProgress.className = 'settings-result success';
            elements.packageProgress.textContent = result.progress.map(item => item.message).filter(Boolean).slice(-3).join(' · ') || translateUi("{0} 完成", action);
            state.resourceSnapshot = null; await loadResources(true);
            toast(translateUi("Package 配置已更新；重新打开 runtime 后生效"), 'success', 6500);
        } catch (error) {
            elements.packageProgress.className = 'settings-result error'; elements.packageProgress.textContent = error.message;
        } finally { setBusy(button, false); }
    }

    function renderSkills() {
        if (!state.resourceSnapshot) return;
        const query = elements.skillSearch.value.trim().toLowerCase();
        const skills = state.resourceSnapshot.skills.filter(skill => !query || `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query));
        elements.skillCommands.checked = state.resourceSnapshot.settings.enableSkillCommands;
        elements.skillList.innerHTML = skills.length ? skills.map(skill => `
            <article class="settings-row skill-row" data-skill-name="${escapeHtml(skill.name)}">
                <span class="settings-model-icon"><i class="fa-solid fa-wand-magic-sparkles"></i></span>
                <div class="settings-row-main"><div class="settings-row-title"><strong>${escapeHtml(skill.name)}</strong>${skill.disableModelInvocation ? `<span class="settings-badge">${translateUi("仅手动")}</span>` : ''}</div><p>${escapeHtml(skill.description)}</p><div class="settings-row-meta"><span>${escapeHtml(skill.scope)}</span><span>${escapeHtml(skill.source)}</span><code title="${escapeHtml(skill.filePath)}">${escapeHtml(skill.filePath)}</code></div></div>
                <div class="settings-row-actions">${skill.manageable ? '<button type="button" class="danger" data-action="delete"><i class="fa-solid fa-trash"></i></button>' : ''}</div>
            </article>
        `).join('') : `<div class="settings-empty">${translateUi("没有发现 Skill")}</div>`;
        elements.skillDiagnostics.innerHTML = state.resourceSnapshot.diagnostics.map(item => `<div class="settings-diagnostic"><i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(item.message)}</span></div>`).join('');
    }

    async function deleteSkill(name, button) {
        if (!confirm(translateUi("删除用户 Skill “{0}”？", name))) return;
        setBusy(button, true);
        try {
            await apiFetch(`/api/pi/settings/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
            state.resourceSnapshot = null; await loadResources(true); toast(translateUi("Skill 已移入回收站"), 'success');
        } catch (error) { toast(error.message, 'error'); }
        finally { setBusy(button, false); }
    }

    function openEditor(title, html) {
        closeEditor();
        state.editorReturnFocus = document.activeElement;
        elements.editorTitle.textContent = title;
        elements.editorBody.innerHTML = html;
        elements.editor.classList.remove('hidden');
        elements.editorBody.querySelectorAll('[data-editor-cancel]').forEach(button => button.addEventListener('click', closeEditor));
    }

    function closeEditor() {
        state.editorEpoch++;
        const login = state.login;
        state.login = null;
        if (login) {
            clearTimeout(login.timer);
            if (login.id && !login.finished) apiFetch(`/api/pi/settings/login/${encodeURIComponent(login.id)}`, { method: 'DELETE' }).catch(() => {});
        }
        elements.editor.classList.add('hidden');
        elements.editorBody.innerHTML = '';
        if (state.editorReturnFocus?.isConnected) state.editorReturnFocus.focus({ preventScroll: true });
        state.editorReturnFocus = null;
    }

    elements.toggle.addEventListener('click', () => openSettings(['extensions', 'packages', 'skills'].includes(state.activeTab) ? 'providers' : state.activeTab));
    window.addEventListener('workspace:open-settings', event => {
        const detail = event.detail || {};
        if (detail.setting) nativeSettings.focusSetting(detail.setting);
        if (detail.promptKind) systemPrompts.focus(detail.promptKind, detail.promptScope);
        if (detail.providerSearch !== undefined) {
            elements.providerSearch.value = String(detail.providerSearch);
            elements.modelSearch.value = String(detail.providerSearch);
            elements.modelAvailable.checked = false;
        }
        if (detail.showConfigured === false) elements.providerConfigured.checked = false;
        openSettings(detail.tab || state.activeTab);
        if (detail.updatePi === true && detail.tab === 'updates') updatesPanel.reviewUpdate();
    });
    elements.close.addEventListener('click', closeSettings);
    elements.dialog.addEventListener('click', event => { if (event.target === elements.dialog) closeSettings(); });
    elements.editorClose.addEventListener('click', closeEditor);
    elements.editor.addEventListener('click', event => { if (event.target === elements.editor) closeEditor(); });
    elements.nav.addEventListener('click', event => {
        const button = event.target.closest('[data-settings-tab]');
        if (button) switchTab(button.dataset.settingsTab);
    });
    document.addEventListener('keydown', event => {
        if (document.querySelector('dialog[open]')) return;
        if (event.key === 'Tab' && !elements.editor.classList.contains('hidden')) {
            const controls = [...elements.editor.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary')].filter(node => node.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && (document.activeElement === first || !elements.editor.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !elements.editor.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
        }
        if (event.key === 'Tab' && elements.editor.classList.contains('hidden') && !elements.dialog.classList.contains('hidden')) {
            const controls = [...elements.dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary')].filter(node => node.getClientRects().length);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && (document.activeElement === first || !elements.dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && (document.activeElement === last || !elements.dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
        }
        if (event.key !== 'Escape') return;
        if (!elements.editor.classList.contains('hidden')) closeEditor();
        else if (!elements.dialog.classList.contains('hidden')) closeSettings();
    });

    elements.providerSearch.addEventListener('input', renderProviders);
    elements.providerConfigured.addEventListener('change', renderModels);
    elements.refreshProviders.addEventListener('click', () => { state.modelSnapshot = null; loadModels(true).catch(error => toast(error.message, 'error')); });
    elements.addProvider.addEventListener('click', () => openProviderEditor(null));
    elements.providerList.addEventListener('click', event => {
        const row = event.target.closest('[data-provider-id]'); const button = event.target.closest('[data-action]');
        if (!row || !button) return;
        const id = row.dataset.providerId; const action = button.dataset.action;
        if (action === 'key') openApiKeyEditor(id);
        if (action === 'logout') removeCredential(id, button);
        if (action === 'edit') openProviderEditor(customProvider(id));
        if (action === 'delete') deleteProvider(id, button);
    });

    elements.modelSearch.addEventListener('input', renderModels);
    elements.modelProvider.addEventListener('change', renderModels);
    elements.mediaAgentProvider.addEventListener('change', () => populateMediaAgentModelSelect());
    elements.mediaAgentForm.addEventListener('submit', event => {
        event.preventDefault();
        saveMediaAgentModel(elements.mediaAgentForm.querySelector('[type=submit]'));
    });
    elements.mediaAgentTest.addEventListener('click', () => {
        const provider = elements.mediaAgentProvider.value;
        const modelId = elements.mediaAgentModel.value;
        if (provider && modelId) testModel(provider, modelId, elements.mediaAgentTest);
    });
    elements.modelAvailable.addEventListener('change', renderModels);
    elements.refreshModels.addEventListener('click', () => refreshModelCatalog(elements.refreshModels));
    elements.addModel.addEventListener('click', () => openModelEditor('', null));
    elements.modelList.addEventListener('toggle', event => {
        const group = event.target;
        if (!group.matches('.settings-model-group') || !elements.modelList.contains(group)) return;
        const provider = group.querySelector('summary').dataset.provider;
        state.modelGroupOpen.set(provider, group.open);
        if (group.open && !group.querySelector('.settings-provider-models').childElementCount) renderModelGroup(group);
    }, true);
    elements.modelList.addEventListener('click', event => {
        const providerRow = event.target.closest('.provider-row');
        const providerButton = event.target.closest('[data-action]');
        if (providerRow && providerButton) {
            const id = providerRow.dataset.providerId;
            const action = providerButton.dataset.action;
            if (action === 'key') state.modelSnapshot.providerLogin ? openProviderLogin(id, 'api_key') : openApiKeyEditor(id);
            if (action === 'oauth') openProviderLogin(id, 'oauth');
            if (action === 'logout') removeCredential(id, providerButton);
            if (action === 'edit') openProviderEditor(customProvider(id));
            if (action === 'add-model') openModelEditor(id, null);
            if (action === 'delete') deleteProvider(id, providerButton);
            return;
        }
        const pagination = event.target.closest('[data-model-page]');
        if (pagination) {
            const group = pagination.closest('.settings-model-group');
            const provider = group.querySelector('summary').dataset.provider;
            state.modelGroupPages.set(provider, Math.max(0, (state.modelGroupPages.get(provider) || 0) + (pagination.dataset.modelPage === 'next' ? 1 : -1)));
            renderModelGroup(group);
            const panel = group.closest('.workspace-settings-panel');
            panel.scrollTop += group.getBoundingClientRect().top - panel.getBoundingClientRect().top;
            group.querySelector('summary').focus({ preventScroll: true });
            return;
        }
        const row = event.target.closest('[data-model-id]'); const button = event.target.closest('[data-action]');
        if (!row || !button) return;
        const provider = row.dataset.providerId; const modelId = row.dataset.modelId; const action = button.dataset.action;
        const custom = customProvider(provider)?.models.find(model => model.id === modelId);
        if (action === 'thinking') openThinkingEditor(provider, modelId);
        if (action === 'test') testModel(provider, modelId, button);
        if (action === 'default') setDefaultModel(provider, modelId, button);
        if (action === 'edit') openModelEditor(provider, custom);
        if (action === 'delete') deleteModel(provider, modelId, button);
    });

    elements.packageForm.addEventListener('submit', event => {
        event.preventDefault(); const source = elements.packageSource.value.trim(); if (!source) return;
        runPackageAction('install', source, elements.packageForm.querySelector('[type=submit]')).then(() => { elements.packageSource.value = ''; });
    });
    elements.refreshResources.addEventListener('click', () => { state.resourceSnapshot = null; loadResources(true).catch(error => toast(error.message, 'error')); });
    elements.packageList.addEventListener('click', event => {
        const row = event.target.closest('[data-package-source]'); const button = event.target.closest('[data-action]');
        if (row && button) runPackageAction(button.dataset.action, row.dataset.packageSource, button);
    });

    elements.skillSearch.addEventListener('input', renderSkills);
    elements.skillCommands.addEventListener('change', async () => {
        try {
            await apiFetch('/api/pi/settings/skill-commands', {
                method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: elements.skillCommands.checked, cwd: currentCwd() })
            });
            if (state.resourceSnapshot) state.resourceSnapshot.settings.enableSkillCommands = elements.skillCommands.checked;
            toast(translateUi("Skill command 设置已保存；重新打开 runtime 后生效"), 'success');
        } catch (error) { elements.skillCommands.checked = !elements.skillCommands.checked; toast(error.message, 'error'); }
    });
    elements.skillList.addEventListener('click', event => {
        const row = event.target.closest('[data-skill-name]'); const button = event.target.closest('[data-action]');
        if (row && button?.dataset.action === 'delete') deleteSkill(row.dataset.skillName, button);
    });
});
