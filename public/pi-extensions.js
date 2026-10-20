/* Curated discovery metadata; messaging connectors have a dedicated setup page. */
(() => {
    const text = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const node = (tag, content, attrs = {}) => {
        const el = document.createElement(tag);
        if (content != null) el.textContent = content;
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        return el;
    };
    const entries = [
        { id: 'pivane-weixin', type: 'channel', name: 'WeChat ClawBot', author: 'Tencent · Pivane', kind: ['可选组件 · 消息渠道', 'Optional · Messaging'], icon: 'fa-comments',
            url: 'https://github.com/Tencent/openclaw-weixin',
            title: ['在微信继续对话', 'Continue in WeChat'],
            description: ['扫码连接微信 ClawBot，把私聊绑定到 Pivane 线程，支持图片、文件、斜杠指令和定时通知。', 'Connect WeChat ClawBot with a QR code and bind a DM to a Pivane thread, with images, files, slash commands and scheduled notifications.'],
            requirement: ['按需下载连接组件；支持文字与图片私聊、文件交付及定时推送，需要扫码和线程绑定。', 'Downloads the connector on demand. Supports text/image DMs, file delivery and scheduled notifications with QR login and a thread binding.'],
            example: ['把当前项目线程连接到我的微信聊天。', 'Connect this project thread to my WeChat chat.'] },
        { id: 'ppt-master', type: 'skill', name: 'PPT Master', author: 'hugohe3', kind: ['技能工作流', 'Skill workflow'], icon: 'fa-file-powerpoint',
            url: 'https://github.com/hugohe3/ppt-master',
            title: ['制作演示文稿', 'Create presentations'],
            description: ['把资料整理成可编辑的 PPT，支持模板填充与版式设计。', 'Turn source material into editable presentations, with template filling and slide design.'],
            requirement: ['需要 Python 3.10+ 和项目依赖；由助手核对 Pi 技能接入方式。', 'Requires Python 3.10+ and project dependencies; the assistant checks how to integrate the skill with Pi.'],
            example: ['把这份项目资料做成一份十页汇报 PPT。', 'Turn these project notes into a ten-slide presentation.'] },
        { id: 'pi-native-mcp', type: 'mcp', name: 'Pi MCP', author: 'Earendil Works', kind: ['Pi 内置 · MCP', 'Built-in · MCP'], icon: 'fa-plug',
            url: 'https://github.com/earendil-works/pi/blob/v0.99.1/packages/coding-agent/docs/mcp.md',
            title: ['连接外部工具', 'Connect external tools'],
            description: ['连接 MCP 服务，让 Agent 使用你需要的数据和工具。', 'Connect MCP servers so your agent can use the data and tools you need.'],
            requirement: ['Pi 原生能力，无需安装适配器；配置 mcp.json，部分服务需 OAuth 授权。', 'Native to Pi; no adapter installation needed. Configure mcp.json; some servers require OAuth authorization.'],
            example: ['帮我接入一个 MCP 服务，并检查有哪些可用工具。', 'Help me connect an MCP server and check its available tools.'] },
        { id: 'pi-web-access', type: 'package', name: 'pi-web-access', author: 'nicobailon', kind: ['扩展包 · 检索', 'Package · Research'], icon: 'fa-globe',
            url: 'https://pi.dev/packages/pi-web-access', source: 'npm:pi-web-access',
            title: ['搜索与阅读网页', 'Search and read the web'],
            description: ['搜索网页、提取页面内容，把网络资料带入任务。', 'Search the web and extract page content for your tasks.'],
            requirement: ['需要网络；搜索与抓取方式的配置由助手按当前版本核对。', 'Requires network access; the assistant checks search and extraction setup for the current version.'],
            example: ['查找这个技术问题的最新资料，并附上来源链接。', 'Find current information about this technical question and include source links.'] },
        { id: 'pi-computer-use', type: 'package', name: 'pi-computer-use', author: 'injaneity', kind: ['扩展包 · 桌面', 'Package · Desktop'], icon: 'fa-desktop',
            url: 'https://github.com/injaneity/pi-computer-use', source: 'npm:@injaneity/pi-computer-use',
            title: ['操作桌面应用', 'Use desktop applications'],
            description: ['让 Agent 查看窗口、点击和输入，协助完成桌面任务。', 'Let your agent inspect windows, click, and type to help with desktop tasks.'],
            requirement: ['操作部署端桌面；需要图形会话及系统权限，Linux/Wayland 功能有限。', 'Controls the deployment machine’s desktop; requires a graphical session and OS permissions. Linux/Wayland features are limited.'],
            example: ['先检查这台机器的桌面环境是否支持，再给出配置方案。', 'Check whether this machine’s desktop is supported, then propose a setup.'] },
        { id: 'pi-subagents', type: 'package', name: 'pi-subagents', author: 'nicobailon', kind: ['扩展包 · 协作', 'Package · Collaboration'], icon: 'fa-people-group',
            url: 'https://pi.dev/packages/pi-subagents', source: 'npm:pi-subagents',
            title: ['让多个 Agent 协作', 'Work with multiple agents'],
            description: ['把调研、实现与审查交给专门的子 Agent，支持并行任务与工作流。', 'Delegate research, implementation and review to focused agents, with parallel tasks and workflows.'],
            requirement: ['需要可用的模型认证；子任务会产生模型用量。已有安装先核对版本与配置。', 'Requires model authentication; child tasks consume model usage. Check the version and configuration of any existing installation first.'],
            example: ['请让 reviewer 检查这次修改，并汇总需要修复的问题。', 'Ask reviewer to inspect this change and summarize the issues to fix.'] },
        { id: 'pi-hermes-memory', type: 'package', name: 'pi-hermes-memory', author: 'chandra447', kind: ['扩展包 · 记忆', 'Package · Memory'], icon: 'fa-brain',
            url: 'https://pi.dev/packages/pi-hermes-memory?name=memory', source: 'npm:pi-hermes-memory',
            title: ['记住偏好与项目经验', 'Remember preferences and project knowledge'],
            description: ['跨会话保存偏好与经验，并搜索以前的对话和记忆。', 'Save preferences and lessons across sessions, and search past conversations and memories.'],
            requirement: ['会在部署端持久保存记忆与搜索索引；SQLite 原生依赖须兼容当前 Node，安装前核对记录范围和自动学习设置。', 'Persists memories and search indexes on the deployment machine. Its native SQLite dependency must match Node; review storage scope and automatic learning before setup.'],
            example: ['先说明会保存哪些内容，以及如何查看、修改和删除记忆，再给出配置方案。', 'Explain what is stored and how to inspect, edit and remove memories, then propose a setup.'] }
    ];
    const open = () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'extensions' } }));
    const button = (label, action, attrs = {}) => {
        const el = node('button', label, { type: 'button', ...attrs });
        el.addEventListener('click', action); return el;
    };
    let mcpPanel, channelsPanel;
    let enabled = false, host, generation = 0, view = '', inventory = null, inventoryState = 'unknown', channelsInfo = null, piVersion = '', renderCards = () => {}, resetDiscovery = () => {}, subnav = null;
    const repositories = { 'ppt-master': 'hugohe3/ppt-master', 'pi-web-access': 'nicobailon/pi-web-access', 'pi-computer-use': 'injaneity/pi-computer-use', 'pi-subagents': 'nicobailon/pi-subagents', 'pi-hermes-memory': 'chandra447/pi-hermes-memory' };
    function identity(source) {
        if (typeof source !== 'string') return '';
        const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@[^/]+)?$/.exec(source);
        if (npm) return `npm:${npm[1]}`;
        const git = /^(?:git:github\.com\/|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#@]+?)(?:\.git)?(?:[@#][^\s]+)?\/?$/.exec(source);
        return git ? `github:${git[1].toLowerCase()}` : '';
    }
    const versionText = value => typeof value === 'string' && /^[\w.+-]{1,40}$/.test(value) ? (/^\d/.test(value) ? `v${value}` : value) : '';
    const scopeText = items => {
        const global = items.some(item => item.scope === 'user' || item.scope === 'global');
        const project = items.some(item => item.scope === 'project');
        return global && project ? text('全局与项目', 'Global & project') : project ? text('当前项目', 'Project') : text('所有项目', 'Global');
    };
    const hasUpdate = pkg => Boolean(inventory?.updates?.available?.some(item => item.source === pkg.source && item.scope === pkg.scope));
    // Messaging connectors report their own lifecycle; installation is never inferred from Pi packages.
    function weixinState() {
        const c = channelsInfo;
        if (!c || !c.component.installed) return { state: 'optional', label: text('按需安装', 'Optional'), action: text('安装与连接', 'Install & connect') };
        if (c.component.broken) return { state: 'unknown', label: text('组件需要修复', 'Connector needs repair'), action: text('查看与修复', 'Review & repair') };
        const connected = c.accounts.filter(account => account.connection === 'connected').length, version = versionText(c.component.version);
        if (connected) return { state: 'installed', label: text(`已连接 · ${connected} 个账号`, `Connected · ${connected} account${connected === 1 ? '' : 's'}`), version, action: text('管理连接', 'Manage') };
        return { state: 'configured', label: text('已安装 · 未连接', 'Installed · not connected'), version, action: text('扫码连接', 'Connect') };
    }
    function installation(entry) {
        if (entry.id === 'pivane-weixin') return weixinState();
        if (inventoryState !== 'ready') return { state: inventoryState, label: inventoryState === 'loading' ? text('正在核对…', 'Checking…') : text('状态待核对', 'Status unknown') };
        if (entry.id === 'pi-native-mcp') {
            const builtin = inventory.resources?.find(item => item.path === 'builtin:mcp');
            return builtin ? { state: builtin.enabled ? 'installed' : 'configured', label: text(builtin.enabled ? 'Pi 原生内置' : 'Pi 内置 · 已停用', builtin.enabled ? 'Native Pi built-in' : 'Built-in · disabled'), version: versionText(piVersion) ? `Pi ${piVersion}` : '' }
                : { state: 'unknown', label: text('需核对 Pi 版本', 'Check Pi version') };
        }
        if (entry.id === 'pi-hermes-memory' && inventory.profileMemoryInstalled) return { state: 'installed', label: text('档案适配已安装', 'Profile adapter installed') };
        if (entry.id === 'ppt-master') {
            const skills = Array.isArray(inventory.featuredSkills) ? inventory.featuredSkills.filter(item => item.id === entry.id) : [];
            if (skills.length) {
                const enabled = skills.some(item => item.enabled);
                const version = [...new Set(skills.map(item => versionText(item.version)).filter(Boolean))].join(' / ');
                return { state: enabled ? 'installed' : 'configured', label: text(enabled ? '已发现技能' : '已发现 · 已停用', enabled ? 'Skill found' : 'Found · disabled') + ' · ' + scopeText(skills), version };
            }
        }
        const bundled = inventory.packages.find(item => item.managedBy === 'pivane' && item.name === entry.id && item.installed);
        if (bundled) return { state: 'installed', label: text('Pivane 内置', 'Bundled with Pivane'), version: versionText(bundled.version), note: text('随 Pivane 更新', 'Updates with Pivane') };
        const matches = inventory.packages.filter(item => identity(item.source) === entry.source || identity(item.source) === `github:${repositories[entry.id]}`);
        const installed = matches.filter(item => item.installed === true);
        if (installed.length) {
            const version = [...new Set(installed.map(item => versionText(item.version)).filter(Boolean))].join(' / ');
            return { state: 'installed', label: text('已安装', 'Installed') + ' · ' + scopeText(installed), version, update: installed.some(hasUpdate) };
        }
        if (matches.length) return { state: 'configured', label: text('已配置 · 文件未就绪', 'Configured · files unavailable') };
        if (inventory.scope === 'project' && !inventory.trust?.effective || !entry.source && (!Array.isArray(inventory.featuredSkills) || inventory.featuredSkillNeedsReview)) return { state: 'unknown', label: text('需助手核对', 'Check with assistant') };
        if (!entry.source) return { state: 'missing', label: text('未发现技能', 'Skill not found') };
        return { state: 'missing', label: text('未安装', 'Not installed') };
    }
    const validChannels = value => value && typeof value === 'object' && value.component && typeof value.component === 'object' && Array.isArray(value.accounts);
    async function refreshInventory() {
        if (!host || view !== 'extensions') return;
        const ticket = ++generation, selected = host.currentCwd();
        const selector = document.getElementById('extensions-scope');
        const scope = selected && selector.value === 'project' ? 'project' : 'global';
        selector.querySelector('[value="project"]').hidden = !selected; selector.value = scope;
        inventory = null; inventoryState = 'loading'; channelsInfo = null; renderCards();
        const feedback = document.getElementById('extensions-inventory-status');
        feedback.dataset.tone = 'info';
        feedback.textContent = text('正在读取安装清单…', 'Reading installation inventory…');
        const valid = () => ticket === generation && view === 'extensions' && selected === host.currentCwd();
        try {
            const status = await host.apiFetch('/api/pi/status');
            if (!valid()) return;
            piVersion = typeof status.version === 'string' ? status.version : '';
            const channelsRead = status.messageChannels ? host.apiFetch('/api/pi/channels').catch(() => null) : Promise.resolve(null);
            const cwd = selected || status.defaultProject;
            if (!status.nativeResources || !cwd) throw new Error(text('当前服务无法提供安装清单。', 'Installation inventory is unavailable on this server.'));
            const result = await host.apiFetch(`/api/pi/settings/native/resources?cwd=${encodeURIComponent(cwd)}&scope=${scope}`);
            if (!valid()) return;
            if (!Array.isArray(result?.packages) || result.scope !== scope || !result.packages.every(item => typeof item.source === 'string' && typeof item.installed === 'boolean')
                || result.featuredSkills !== undefined && (!Array.isArray(result.featuredSkills) || !result.featuredSkills.every(item => item.id === 'ppt-master' && ['user', 'project'].includes(item.scope) && typeof item.enabled === 'boolean'))) throw new Error(text('安装清单格式无效。', 'Invalid installation inventory.'));
            const channels = await channelsRead;
            if (!valid()) return;
            channelsInfo = validChannels(channels) ? channels : null;
            inventory = { ...result, profileMemoryInstalled: status.profileMemory?.installed === true }; inventoryState = 'ready';
            const checked = result.updates?.checkedAt ? new Date(result.updates.checkedAt) : null;
            const updateNote = checked && Number.isFinite(checked.getTime())
                ? text(` 上次检查更新：${checked.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })}。`, ` Last update check: ${checked.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}.`)
                : text(' 可在“已安装”页手动检查更新。', ' Check for updates on the Installed tab.');
            feedback.textContent = scope === 'project' && !result.trust?.effective
                ? text('项目尚未受信任，仅能确认全局安装；其他项需进一步核对。', 'The project is not trusted. Only global installations can be confirmed; other items need checking.')
                : text('已按所选范围核对来源与技能声明；“已安装”不代表依赖就绪或已在当前会话加载。', 'Checked sources and skill declarations in the selected scope. Installed does not mean dependencies are ready or loaded in this session.') + updateNote;
        } catch (error) {
            if (!valid()) return;
            inventory = null; inventoryState = 'unknown';
            feedback.dataset.tone = 'error';
            feedback.textContent = text('安装状态读取失败，可点击刷新重试：', 'Could not read installation status. Refresh to retry: ') + error.message;
        } finally { if (valid()) renderCards(); }
    }
    function assistant(entry) {
        let need = entry ? text(
            `我想了解并配置 ${entry.name}。来源：${entry.url}${entry.source ? `，Pi 包来源：${entry.source}` : ''}。用途：${text(...entry.description)} 示例：${text(...entry.example)} 请先只读检查已有安装、当前版本、许可、依赖和平台兼容性，说明安装范围与方案，等我确认后再安装；不要重复安装已有能力。安装后分别核对文件、依赖与当前会话加载状态。`,
            `I want to learn about and configure ${entry.name}. Source: ${entry.url}${entry.source ? `; Pi package source: ${entry.source}` : ''}. Purpose: ${text(...entry.description)} Example: ${text(...entry.example)} First inspect existing installations, versions, licenses, dependencies and platform compatibility read-only. Explain the scope and plan, then wait for my confirmation before installing. Avoid duplicate installations. After installation, check files, dependencies and current-session loading separately.`) : '';
        if (entry?.id === 'pi-native-mcp') need = text(
            '请帮我配置 Pi 原生 MCP。先检查全局或受信项目的 mcp.json、连接和工具暴露策略；不要安装 pi-mcp-adapter，不要展示凭据。使用 Pi 原生 MCP/Codemode 接口，写配置和授权前说明方案并等我确认。',
            'Help configure native Pi MCP. Inspect global or trusted-project mcp.json, connections and tool exposure. Do not install pi-mcp-adapter or display credentials. Use native MCP/Codemode; explain the plan and wait for confirmation before configuration changes or sign-in.');
        if (entry && ['pi-subagents', 'pi-hermes-memory'].includes(entry.id)) need = text(
            `请帮我配置 Pivane 内置的 ${entry.name}。该组件随 Pivane 安装和更新，请先检查当前版本、资源开关、身份与会话加载状态，再调整配置，不要另行安装或修改上游源码。`,
            `Help me configure ${entry.name}, bundled with Pivane. Check its version, resource toggles, profile and actual session loading before adjusting settings. It updates with Pivane; do not install another copy or modify upstream source.`);
        if (entry?.id === 'pi-hermes-memory' && inventory?.profileMemoryInstalled) need += text(
            '\nPivane 已安装独立的档案记忆适配组件。请先检查助手身份和实际加载状态；不要另行全局启用上游默认扩展，以免扩大历史索引范围。',
            '\nPivane already has the separate profile memory adapter installed. Inspect assistant profiles and actual loading first; do not additionally enable the upstream default extension globally, which would broaden history indexing.');
        window.dispatchEvent(new CustomEvent('pi:extension-assistant', { detail: { need, scope: document.getElementById('extensions-scope')?.value || 'global' } }));
    }
    function mountExplore(root) {
        if (!root || root.querySelector('.extensions-explore')) return;
        const section = node('section', null, { class: 'extensions-explore', 'aria-label': text('探索技能', 'Explore skills') });
        const header = node('div', null, { class: 'extensions-explore-heading' });
        const openFeatured = () => open();
        header.append(node('strong', text('探索技能', 'Explore skills')), button(text('查看全部', 'View all'), openFeatured));
        const choices = node('div', null, { class: 'extensions-explore-choices' });
        for (const item of entries.slice(0, 3)) choices.append(button(text(...item.title), () => {
            openFeatured();
            resetDiscovery();
            const card = document.getElementById(`extension-${item.id}`);
            card?.scrollIntoView({ block: 'nearest' }); card?.focus({ preventScroll: true });
        }));
        section.append(header, choices); root.append(section);
    }
    const extensionTabLabels = {
        extensions: ['发现', 'Discover'],
        installed: ['已安装', 'Installed'],
        mcp: ['MCP', 'MCP'],
        channels: ['消息渠道', 'Messaging']
    };
    function mountSubnav() {
        const dialog = document.getElementById('workspace-settings-dialog');
        const header = dialog?.querySelector('.workspace-settings-header');
        if (!dialog || !header || document.getElementById('extensions-nav')) return;
        subnav = node('nav', null, { class: 'extensions-nav', id: 'extensions-nav', 'aria-label': text('扩展分类', 'Extension categories'), hidden: '' });
        const tabs = node('div', null, { class: 'extensions-nav-tabs' });
        for (const [tab, label] of Object.entries(extensionTabLabels)) {
            const item = button(text(...label), () => {
                window.PiWorkspaceRoute?.navigate('extensions', { tab });
                if (tab === 'mcp') window.PiExtensions.setView('extensions', 'mcp');
            }, { 'data-extensions-tab': tab, type: 'button' });
            item.classList.add('extensions-nav-tab');
            tabs.append(item);
        }
        const actions = node('div', null, { class: 'extensions-nav-actions' });
        // The visible label collapses to the icon on phones; the accessible name stays the same.
        const install = button('', () => window.dispatchEvent(new CustomEvent('pi:extensions-install')), { id: 'extensions-install', type: 'button', 'aria-label': text('安装扩展包', 'Install package'), title: text('安装扩展包', 'Install package') });
        install.className = 'settings-primary-button';
        install.append(node('i', '', { class: 'fa-solid fa-plus', 'aria-hidden': 'true' }), node('span', text('安装扩展包', 'Install package'), { class: 'extensions-install-label' }));
        actions.append(install);
        const inner = node('div', null, { class: 'extensions-nav-inner' });
        inner.append(tabs, actions);
        subnav.append(inner);
        header.after(subnav);
    }
    window.PiExtensions = {
        connect(value) {
            host = value;
            channelsPanel?.close(); channelsPanel?.root.remove();
            if (window.PiChannels) {
                channelsPanel = window.PiChannels.create(value);
                document.querySelector('.workspace-settings-content')?.append(channelsPanel.root);
            }
            mcpPanel?.close(); mcpPanel?.root.remove();
            if (window.PiMcpSettings) {
                mcpPanel = window.PiMcpSettings.create(value);
                document.querySelector('.workspace-settings-content')?.append(mcpPanel.root);
            }
        },
        mountExplore,
        setChannelTarget(value) { channelsPanel?.setTarget(value); },
        setAssistantEnabled(value) {
            enabled = Boolean(value);
            document.querySelectorAll('[data-extension-configure]').forEach(el => { el.disabled = !enabled; });
            renderCards();
            const hint = document.getElementById('extensions-assistant-unavailable'); if (hint) hint.hidden = enabled;
        },
        setView(nextView, tab) {
            const extensionView = nextView === 'extensions';
            view = extensionView ? (extensionTabLabels[tab] ? tab : 'extensions') : nextView;
            generation++;
            const dialog = document.getElementById('workspace-settings-dialog');
            dialog?.classList.toggle('extensions-view', extensionView);
            if (subnav) {
                subnav.hidden = !extensionView;
                subnav.querySelector('.extensions-nav-actions').hidden = view === 'channels';
                subnav.querySelectorAll('[data-extensions-tab]').forEach(item => {
                    const active = extensionView && item.dataset.extensionsTab === view;
                    item.classList.toggle('active', active);
                    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
                });
            }
            if (view === 'channels') {
                document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.remove('active'));
                channelsPanel?.open();
            } else channelsPanel?.close();
            if (view === 'mcp') {
                document.querySelectorAll('[data-settings-panel]').forEach(panel => panel.classList.remove('active'));
                mcpPanel?.open();
            } else mcpPanel?.close();
            if (view === 'extensions') void refreshInventory();
            const close = document.getElementById('workspace-settings-close');
            if (close) close.title = close.ariaLabel = extensionView ? text('关闭扩展', 'Close extensions') : text('关闭设置', 'Close settings');
            document.querySelector('.workspace-settings-nav')?.setAttribute('aria-label', extensionView ? text('扩展分类', 'Extension categories') : text('设置分类', 'Settings categories'));
        }
    };
    document.addEventListener('DOMContentLoaded', () => {
        mountSubnav();
        const panel = node('section', null, { class: 'workspace-settings-panel', 'data-settings-panel': 'extensions' });
        const featured = node('section', null, { id: 'extensions-featured' });
        const intro = node('header', null, { class: 'extensions-head' });
        const introIcon = node('span', null, { class: 'extensions-head-icon', 'aria-hidden': 'true' });
        introIcon.append(node('i', '', { class: 'fa-solid fa-compass', 'aria-hidden': 'true' }));
        const introCopy = node('div', null, { class: 'extensions-head-copy' });
        introCopy.append(node('h3', text('发现扩展', 'Discover extensions')), node('p', text('精选工具与技能，按需配置到 Pivane。浏览不会安装任何内容。', 'Curated tools and skills to add when you need them. Browsing installs nothing.')));
        const customBtn = button(text('让助手帮我找', 'Ask the assistant'), () => assistant(), { class: 'settings-secondary-button extensions-head-action', 'data-extension-configure': '', disabled: '' });
        customBtn.prepend(node('i', '', { class: 'fa-solid fa-wand-magic-sparkles', 'aria-hidden': 'true' }));
        intro.append(introIcon, introCopy, customBtn);
        const controlsRow = node('div', null, { class: 'extensions-controls-bar' });
        const searchWrap = node('label', null, { class: 'extensions-search-field' });
        const search = node('input', null, { type: 'search', id: 'extensions-search', placeholder: text('搜索名称、用途或作者', 'Search names, uses, or authors'), 'aria-label': text('搜索精选扩展', 'Search featured extensions') });
        searchWrap.append(node('i', '', { class: 'fa-solid fa-magnifying-glass', 'aria-hidden': 'true' }), search);
        const toolbar = node('div', null, { class: 'extensions-inventory-toolbar' });
        const scope = node('select', null, { id: 'extensions-scope', 'aria-label': text('核对安装范围', 'Installation scope') });
        scope.append(node('option', text('所有项目', 'Global'), { value: 'global' }), node('option', text('当前项目（含全局）', 'Current project (including global)'), { value: 'project' }));
        scope.addEventListener('change', () => void refreshInventory());
        const refreshBtn = button(text('刷新', 'Refresh'), () => void refreshInventory(), { class: 'settings-secondary-button', id: 'extensions-refresh', 'aria-label': text('刷新安装状态', 'Refresh installation status'), title: text('刷新安装状态', 'Refresh installation status') });
        refreshBtn.prepend(node('i', '', { class: 'fa-solid fa-rotate', 'aria-hidden': 'true' }));
        toolbar.append(scope, refreshBtn);
        controlsRow.append(searchWrap, toolbar);
        // Type and installation facets; counts follow the search and the other facet.
        const filters = node('div', null, { class: 'extensions-filters' });
        const typeGroup = node('div', null, { class: 'extensions-filter-group', role: 'group', 'aria-label': text('按类型筛选', 'Filter by type') });
        const statusGroup = node('div', null, { class: 'extensions-filter-group', role: 'group', 'aria-label': text('按安装状态筛选', 'Filter by installation') });
        filters.append(typeGroup, node('span', null, { class: 'extensions-filter-divider', 'aria-hidden': 'true' }), statusGroup);
        let typeFilter = 'all', statusFilter = '';
        const facet = (group, value, caption, onClick) => {
            const item = button(caption, onClick, { class: 'extensions-filter', 'data-extension-filter': value, 'aria-pressed': 'false' });
            const count = node('span', '0', { class: 'extensions-filter-count' });
            item.append(count); group.append(item);
            return { item, count };
        };
        const typeButtons = new Map([['all', text('全部', 'All')], ['package', text('扩展包', 'Packages')], ['skill', text('技能', 'Skills')], ['channel', text('消息渠道', 'Messaging')], ['mcp', 'MCP']]
            .map(([value, caption]) => [value, facet(typeGroup, value, caption, () => { typeFilter = value; render(); })]));
        const statusButtons = new Map([['installed', text('已安装', 'Installed')], ['missing', text('未安装', 'Not installed')]]
            .map(([value, caption]) => [value, facet(statusGroup, value, caption, () => { statusFilter = statusFilter === value ? '' : value; render(); })]));
        const statusOf = entry => {
            const state = installation(entry).state;
            return ['installed', 'configured'].includes(state) ? 'installed' : ['missing', 'optional'].includes(state) ? 'missing' : '';
        };
        const feedback = node('p', '', { id: 'extensions-inventory-status', class: 'extensions-note', role: 'status' });
        const grid = node('div', null, { class: 'extensions-grid' });
        const empty = node('div', null, { hidden: '', class: 'extensions-empty' });
        const emptyText = node('p', text('没有匹配的精选扩展。', 'No matching featured extensions.'), { role: 'status' });
        const clearFilters = button(text('清除筛选', 'Clear filters'), () => { resetDiscovery(); search.focus(); }, { class: 'settings-secondary-button' });
        empty.append(emptyText, clearFilters);
        const cards = new Map();
        for (const entry of entries) {
            const card = node('article', null, { class: 'extensions-card', id: `extension-${entry.id}`, tabindex: '-1', 'data-type': entry.type });
            const top = node('div', null, { class: 'extensions-card-top' });
            const glyph = node('span', null, { class: 'extensions-card-icon', 'aria-hidden': 'true' });
            glyph.append(node('i', '', { class: `fa-solid ${entry.icon}`, 'aria-hidden': 'true' }));
            const titleBlock = node('div', null, { class: 'extensions-card-title' });
            titleBlock.append(node('span', text(...entry.kind), { class: 'extensions-kind' }), node('h4', text(...entry.title)), node('small', `${entry.name} · ${entry.author}`));
            top.append(glyph, titleBlock);
            const details = node('details', null, { class: 'extensions-card-more' });
            details.append(node('summary', text('使用前提与示例', 'Requirements & example')));
            for (const [caption, value] of [[text('使用前提', 'Requirements'), entry.requirement], [text('可以这样说', 'Try asking'), entry.example]]) {
                const block = node('div', null, { class: 'extensions-detail' });
                block.append(node('strong', caption), node('p', text(...value)));
                details.append(block);
            }
            const state = node('div', null, { class: 'extensions-card-state' });
            const badge = node('span', '', { class: 'extensions-installation' });
            const version = node('span', '', { class: 'extensions-version' });
            const update = node('span', text('有可用更新', 'Update available'), { class: 'extensions-update', title: text('可在“已安装”页更新', 'Update it on the Installed tab') });
            state.append(badge, version, update);
            const actions = node('div', null, { class: 'extensions-card-actions' });
            const configure = entry.id === 'pivane-weixin'
                ? button(text('安装与连接', 'Install & connect'), () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'channels' } })), { class: 'settings-secondary-button extensions-card-cta' })
                : button(text('了解与配置', 'Learn & set up'), () => assistant(entry), { 'data-extension-configure': '', class: 'settings-secondary-button extensions-card-cta' });
            const sourceLink = node('a', text('来源', 'Source'), { href: entry.url, target: '_blank', rel: 'noopener noreferrer', class: 'extensions-source-link', title: text('查看来源', 'View source'), 'aria-label': `${text('查看来源', 'View source')} · ${entry.name}` });
            sourceLink.append(node('i', '', { class: 'fa-solid fa-arrow-up-right-from-square', 'aria-hidden': 'true' }));
            actions.append(sourceLink, configure);
            card.append(top, node('p', text(...entry.description), { class: 'extensions-card-desc' }), details, state, actions);
            const paint = () => {
                const result = installation(entry);
                badge.textContent = result.label; badge.dataset.installation = card.dataset.installation = result.state;
                version.textContent = result.version || ''; version.hidden = !result.version; version.title = result.note || '';
                update.hidden = !result.update;
                if (entry.id === 'pivane-weixin') configure.textContent = result.action;
                else configure.disabled = !enabled;
            };
            cards.set(entry.id, { card, paint });
        }
        const render = () => {
            const query = search.value.trim().toLowerCase();
            const matchesQuery = entry => [entry.name, entry.author, ...entry.title, ...entry.kind, ...entry.description].join(' ').toLowerCase().includes(query);
            const matches = (entry, type = typeFilter, status = statusFilter) => matchesQuery(entry) && (type === 'all' || entry.type === type) && (!status || statusOf(entry) === status);
            const visible = entries.filter(entry => matches(entry)).map(entry => cards.get(entry.id).card);
            // Keep existing nodes in place so focus and open disclosures survive inventory refreshes.
            if (visible.length !== grid.children.length || visible.some((card, index) => grid.children[index] !== card)) grid.replaceChildren(...visible);
            for (const [value, { item, count }] of typeButtons) {
                count.textContent = String(entries.filter(entry => matches(entry, value)).length);
                item.classList.toggle('active', value === typeFilter); item.setAttribute('aria-pressed', String(value === typeFilter));
            }
            for (const [value, { item, count }] of statusButtons) {
                count.textContent = String(entries.filter(entry => matches(entry, typeFilter, value)).length);
                item.classList.toggle('active', value === statusFilter); item.setAttribute('aria-pressed', String(value === statusFilter));
            }
            empty.hidden = visible.length > 0;
            clearFilters.hidden = !query && typeFilter === 'all' && !statusFilter;
        };
        resetDiscovery = () => { search.value = ''; typeFilter = 'all'; statusFilter = ''; render(); };
        renderCards = () => { for (const { paint } of cards.values()) paint(); render(); };
        search.addEventListener('input', render); renderCards();
        const unavailable = node('p', text('当前服务未提供扩展助手。可查看来源，或在已安装页面管理资源。', 'The extension assistant is unavailable on this server. View the sources or manage resources in the installed tabs.'), { id: 'extensions-assistant-unavailable', role: 'status' });
        featured.append(intro, controlsRow, filters, feedback, unavailable, grid, empty);
        panel.append(featured);
        const invalidate = () => { channelsPanel?.close(); generation++; view = ''; inventory = null; inventoryState = 'unknown'; channelsInfo = null; renderCards(); };
        window.addEventListener('workspace:settings-closed', invalidate);
        window.addEventListener('workspace:access-locked', invalidate);
        window.addEventListener('storage', event => { if (event.key === 'pi.web.cwd' || event.key === null) void refreshInventory(); });
        document.querySelector('.workspace-settings-content').prepend(panel);
        mountExplore(document.querySelector('.pi-empty-state'));
    });
})();
