/* Curated discovery metadata only. Installation always goes through the extension assistant. */
(() => {
    const text = (zh, en) => globalThis.PiI18n?.locale === 'en' ? en : zh;
    const node = (tag, content, attrs = {}) => {
        const el = document.createElement(tag);
        if (content != null) el.textContent = content;
        for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
        return el;
    };
    const entries = [
        { id: 'ppt-master', name: 'PPT Master', author: 'hugohe3', kind: ['技能工作流', 'Skill workflow'], icon: 'fa-file-powerpoint',
            url: 'https://github.com/hugohe3/ppt-master',
            title: ['制作演示文稿', 'Create presentations'],
            description: ['把资料整理成可编辑的 PPT，支持模板填充与版式设计。', 'Turn source material into editable presentations, with template filling and slide design.'],
            requirement: ['需要 Python 3.10+ 和项目依赖；由助手核对 Pi 技能接入方式。', 'Requires Python 3.10+ and project dependencies; the assistant checks how to integrate the skill with Pi.'],
            example: ['把这份项目资料做成一份十页汇报 PPT。', 'Turn these project notes into a ten-slide presentation.'] },
        { id: 'pi-mcp-adapter', name: 'pi-mcp-adapter', author: 'nicobailon', kind: ['扩展包 · MCP', 'Package · MCP'], icon: 'fa-plug',
            url: 'https://pi.dev/packages/pi-mcp-adapter', source: 'npm:pi-mcp-adapter',
            title: ['连接外部工具', 'Connect external tools'],
            description: ['连接 MCP 服务，让 Agent 使用你需要的数据和工具。', 'Connect MCP servers so your agent can use the data and tools you need.'],
            requirement: ['安装后需配置 MCP 服务；部分服务需要账号授权。', 'Configure MCP servers after installation; some services require account authorization.'],
            example: ['帮我接入一个 MCP 服务，并检查有哪些可用工具。', 'Help me connect an MCP server and check its available tools.'] },
        { id: 'pi-web-access', name: 'pi-web-access', author: 'nicobailon', kind: ['扩展包 · 检索', 'Package · Research'], icon: 'fa-globe',
            url: 'https://pi.dev/packages/pi-web-access', source: 'npm:pi-web-access',
            title: ['搜索与阅读网页', 'Search and read the web'],
            description: ['搜索网页、提取页面内容，把网络资料带入任务。', 'Search the web and extract page content for your tasks.'],
            requirement: ['需要网络；搜索与抓取方式的配置由助手按当前版本核对。', 'Requires network access; the assistant checks search and extraction setup for the current version.'],
            example: ['查找这个技术问题的最新资料，并附上来源链接。', 'Find current information about this technical question and include source links.'] },
        { id: 'pi-computer-use', name: 'pi-computer-use', author: 'injaneity', kind: ['扩展包 · 桌面', 'Package · Desktop'], icon: 'fa-desktop',
            url: 'https://github.com/injaneity/pi-computer-use', source: 'npm:@injaneity/pi-computer-use',
            title: ['操作桌面应用', 'Use desktop applications'],
            description: ['让 Agent 查看窗口、点击和输入，协助完成桌面任务。', 'Let your agent inspect windows, click, and type to help with desktop tasks.'],
            requirement: ['操作部署端桌面；需要图形会话及系统权限，Linux/Wayland 功能有限。', 'Controls the deployment machine’s desktop; requires a graphical session and OS permissions. Linux/Wayland features are limited.'],
            example: ['先检查这台机器的桌面环境是否支持，再给出配置方案。', 'Check whether this machine’s desktop is supported, then propose a setup.'] },
        { id: 'pi-subagents', name: 'pi-subagents', author: 'nicobailon', kind: ['扩展包 · 协作', 'Package · Collaboration'], icon: 'fa-people-group',
            url: 'https://pi.dev/packages/pi-subagents', source: 'npm:pi-subagents',
            title: ['让多个 Agent 协作', 'Work with multiple agents'],
            description: ['把调研、实现与审查交给专门的子 Agent，支持并行任务与工作流。', 'Delegate research, implementation and review to focused agents, with parallel tasks and workflows.'],
            requirement: ['需要可用的模型认证；子任务会产生模型用量。已有安装先核对版本与配置。', 'Requires model authentication; child tasks consume model usage. Check the version and configuration of any existing installation first.'],
            example: ['请让 reviewer 检查这次修改，并汇总需要修复的问题。', 'Ask reviewer to inspect this change and summarize the issues to fix.'] },
        { id: 'pi-hermes-memory', name: 'pi-hermes-memory', author: 'chandra447', kind: ['扩展包 · 记忆', 'Package · Memory'], icon: 'fa-brain',
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
    let enabled = false, host, generation = 0, view = '', inventory = null, inventoryState = 'unknown', renderCards = () => {};
    const repositories = { 'ppt-master': 'hugohe3/ppt-master', 'pi-mcp-adapter': 'nicobailon/pi-mcp-adapter', 'pi-web-access': 'nicobailon/pi-web-access', 'pi-computer-use': 'injaneity/pi-computer-use', 'pi-subagents': 'nicobailon/pi-subagents', 'pi-hermes-memory': 'chandra447/pi-hermes-memory' };
    function identity(source) {
        if (typeof source !== 'string') return '';
        const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)(?:@[^/]+)?$/.exec(source);
        if (npm) return `npm:${npm[1]}`;
        const git = /^(?:git:github\.com\/|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/#@]+?)(?:\.git)?(?:[@#][^\s]+)?\/?$/.exec(source);
        return git ? `github:${git[1].toLowerCase()}` : '';
    }
    function installation(entry) {
        if (inventoryState !== 'ready') return { state: inventoryState, label: inventoryState === 'loading' ? text('正在核对…', 'Checking…') : text('状态待核对', 'Status unknown') };
        const matches = inventory.packages.filter(item => identity(item.source) === entry.source || identity(item.source) === `github:${repositories[entry.id]}`);
        const installed = matches.filter(item => item.installed === true);
        if (installed.length) {
            const global = installed.some(item => item.scope === 'user' || item.scope === 'global');
            const project = installed.some(item => item.scope === 'project');
            return { state: 'installed', label: text('已安装', 'Installed') + ' · ' + (global && project ? text('全局与项目', 'Global & project') : project ? text('当前项目', 'Project') : text('所有项目', 'Global')) };
        }
        if (matches.length) return { state: 'configured', label: text('已配置 · 文件未就绪', 'Configured · files unavailable') };
        if (!entry.source || inventory.scope === 'project' && !inventory.trust?.effective) return { state: 'unknown', label: text('需助手核对', 'Check with assistant') };
        return { state: 'missing', label: text('未安装', 'Not installed') };
    }
    async function refreshInventory() {
        if (!host || view !== 'extensions') return;
        const ticket = ++generation, selected = host.currentCwd();
        const selector = document.getElementById('extensions-scope');
        const scope = selected && selector.value === 'project' ? 'project' : 'global';
        selector.querySelector('[value="project"]').hidden = !selected; selector.value = scope;
        inventory = null; inventoryState = 'loading'; renderCards();
        const feedback = document.getElementById('extensions-inventory-status');
        feedback.textContent = text('正在读取安装清单…', 'Reading installation inventory…');
        const valid = () => ticket === generation && view === 'extensions' && selected === host.currentCwd();
        try {
            const status = await host.apiFetch('/api/pi/status');
            if (!valid()) return;
            const cwd = selected || status.defaultProject;
            if (!status.nativeResources || !cwd) throw new Error(text('当前服务无法提供安装清单。', 'Installation inventory is unavailable on this server.'));
            const result = await host.apiFetch(`/api/pi/settings/native/resources?cwd=${encodeURIComponent(cwd)}&scope=${scope}`);
            if (!valid()) return;
            if (!Array.isArray(result?.packages) || result.scope !== scope || !result.packages.every(item => typeof item.source === 'string' && typeof item.installed === 'boolean')) throw new Error(text('安装清单格式无效。', 'Invalid installation inventory.'));
            inventory = result; inventoryState = 'ready';
            feedback.textContent = scope === 'project' && !result.trust?.effective
                ? text('项目尚未受信任，仅能确认全局安装；其他项需进一步核对。', 'The project is not trusted. Only global installations can be confirmed; other items need checking.')
                : text('按所选范围的登记来源核对；已安装不代表当前会话已加载。本地复制的技能需助手核对。', 'Checked against registered sources in the selected scope. Installed does not mean loaded in this session; manually copied skills need an assistant check.');
        } catch (error) {
            if (!valid()) return;
            inventory = null; inventoryState = 'unknown';
            feedback.textContent = text('安装状态读取失败，可点击刷新重试：', 'Could not read installation status. Refresh to retry: ') + error.message;
        } finally { if (valid()) renderCards(); }
    }
    function assistant(entry) {
        const need = entry ? text(
            `我想了解并配置 ${entry.name}。来源：${entry.url}${entry.source ? `，Pi 包来源：${entry.source}` : ''}。用途：${text(...entry.description)} 示例：${text(...entry.example)} 请先只读检查已有安装、当前版本、许可、依赖和平台兼容性，说明安装范围与方案，等我确认后再安装；不要重复安装已有能力。安装后分别核对文件、依赖与当前会话加载状态。`,
            `I want to learn about and configure ${entry.name}. Source: ${entry.url}${entry.source ? `; Pi package source: ${entry.source}` : ''}. Purpose: ${text(...entry.description)} Example: ${text(...entry.example)} First inspect existing installations, versions, licenses, dependencies and platform compatibility read-only. Explain the scope and plan, then wait for my confirmation before installing. Avoid duplicate installations. After installation, check files, dependencies and current-session loading separately.`) : '';
        window.dispatchEvent(new CustomEvent('pi:extension-assistant', { detail: { need, scope: document.getElementById('extensions-scope')?.value || 'global' } }));
    }
    function mountExplore(root) {
        if (!root || root.querySelector('.extensions-explore')) return;
        const section = node('section', null, { class: 'extensions-explore', 'aria-label': text('探索技能', 'Explore skills') });
        const header = node('div', null, { class: 'extensions-explore-heading' });
        header.append(node('strong', text('探索技能', 'Explore skills')), button(text('查看全部', 'View all'), open));
        const choices = node('div', null, { class: 'extensions-explore-choices' });
        for (const item of entries.slice(0, 3)) choices.append(button(text(...item.title), () => {
            open();
            const search = document.getElementById('extensions-search');
            if (search?.value) { search.value = ''; search.dispatchEvent(new Event('input')); }
            const card = document.getElementById(`extension-${item.id}`);
            card?.scrollIntoView({ block: 'nearest' }); card?.focus({ preventScroll: true });
        }));
        section.append(header, choices); root.append(section);
    }
    window.PiExtensions = {
        connect(value) { host = value; },
        mountExplore,
        setAssistantEnabled(value) {
            enabled = Boolean(value);
            document.querySelectorAll('[data-extension-configure]').forEach(el => { el.disabled = !enabled; });
            const hint = document.getElementById('extensions-assistant-unavailable'); if (hint) hint.hidden = enabled;
        },
        setView(tab) {
            view = tab; generation++;
            if (tab === 'extensions') void refreshInventory();
            const extensionView = ['extensions', 'packages', 'skills'].includes(tab);
            const dialog = document.getElementById('workspace-settings-dialog');
            dialog.classList.toggle('extensions-view', extensionView);
            document.getElementById('workspace-settings-title').textContent = extensionView ? text('扩展', 'Extensions') : text('设置', 'Settings');
            const close = document.getElementById('workspace-settings-close');
            close.title = close.ariaLabel = extensionView ? text('关闭扩展', 'Close extensions') : text('关闭设置', 'Close settings');
            document.querySelector('.workspace-settings-nav').setAttribute('aria-label', extensionView ? text('扩展分类', 'Extension categories') : text('设置分类', 'Settings categories'));
        }
    };
    document.addEventListener('DOMContentLoaded', () => {
        const desktop = button('', open, { id: 'workspace-extensions-toggle', class: 'nav-btn', title: text('扩展', 'Extensions') });
        desktop.append(node('i', '', { class: 'fa-solid fa-puzzle-piece', 'aria-hidden': 'true' }), node('span', text('扩展', 'Extensions')));
        document.querySelector('.nav-menu').append(desktop);
        const mobile = button('', open, { id: 'pi-drawer-extensions', class: 'extensions-drawer-entry' });
        mobile.append(node('i', '', { class: 'fa-solid fa-puzzle-piece', 'aria-hidden': 'true' }), node('span', text('扩展', 'Extensions')), node('small', text('精选与已安装', 'Featured & installed')));
        document.querySelector('.pi-session-heading').after(mobile);
        const nav = document.querySelector('.workspace-settings-nav');
        nav.prepend(button(text('精选', 'Featured'), () => {}, { 'data-settings-tab': 'extensions' }));
        for (const [tab, label] of [['packages', text('已安装扩展包', 'Installed packages')], ['skills', text('已安装技能', 'Installed skills')]]) {
            nav.querySelector(`[data-settings-tab="${tab}"] span`).textContent = label;
        }
        const panel = node('section', null, { class: 'workspace-settings-panel', 'data-settings-panel': 'extensions' });
        const intro = node('div', null, { class: 'extensions-intro' });
        intro.append(node('h3', text('为你的工作添一种能力', 'Add a capability to your work')), node('p', text('发现适合你的工具与技能，按需配置到 Pivane。', 'Discover tools and skills for your work, and configure them when you need them.')),
            button(text('添加自定义', 'Add custom'), () => assistant(), { class: 'settings-primary-button', 'data-extension-configure': '', disabled: '' }));
        const search = node('input', null, { type: 'search', id: 'extensions-search', placeholder: text('搜索名称、用途或作者', 'Search names, uses, or authors'), 'aria-label': text('搜索精选扩展', 'Search featured extensions') });
        const toolbar = node('div', null, { class: 'extensions-inventory-toolbar' });
        const scope = node('select', null, { id: 'extensions-scope', 'aria-label': text('核对安装范围', 'Installation scope') });
        scope.append(node('option', text('所有项目', 'Global'), { value: 'global' }), node('option', text('当前项目（含全局）', 'Current project (including global)'), { value: 'project' }));
        scope.addEventListener('change', () => void refreshInventory());
        toolbar.append(scope, button(text('刷新安装状态', 'Refresh installation status'), () => void refreshInventory(), { class: 'settings-secondary-button', id: 'extensions-refresh' }));
        const feedback = node('p', '', { id: 'extensions-inventory-status', class: 'extensions-note', role: 'status' });
        const grid = node('div', null, { class: 'extensions-grid' });
        const empty = node('p', text('没有匹配的精选扩展。', 'No matching featured extensions.'), { hidden: '', role: 'status' });
        const render = () => {
            const query = search.value.trim().toLowerCase();
            grid.replaceChildren();
            for (const entry of entries.filter(item => [item.name, item.author, ...item.title, ...item.kind, ...item.description].join(' ').toLowerCase().includes(query))) {
                const card = node('article', null, { class: 'extensions-card', id: `extension-${entry.id}`, tabindex: '-1' });
                const heading = node('div', null, { class: 'extensions-card-heading' });
                heading.append(node('i', '', { class: `fa-solid ${entry.icon}`, 'aria-hidden': 'true' }), node('h4', text(...entry.title)));
                const details = node('details'); details.append(node('summary', text('使用前提与示例', 'Requirements & example')), node('p', text(...entry.requirement)), node('p', text(...entry.example)));
                const actions = node('div', null, { class: 'extensions-card-actions' });
                const configure = button(text('了解与配置', 'Learn & set up'), () => assistant(entry), { 'data-extension-configure': '', class: 'settings-secondary-button' }); configure.disabled = !enabled;
                actions.append(node('a', text('查看来源', 'View source'), { href: entry.url, target: '_blank', rel: 'noopener noreferrer' }), configure);
                const installed = installation(entry);
                const badge = node('span', installed.label, { class: 'extensions-installation', 'data-installation': installed.state });
                card.append(heading, badge, node('small', `${entry.name} · ${entry.author}`), node('p', text(...entry.description)), node('span', text(...entry.kind), { class: 'extensions-kind' }), details, actions); grid.append(card);
            }
            empty.hidden = grid.childElementCount > 0;
        };
        renderCards = () => {
            for (const entry of entries) {
                const badge = document.querySelector(`#extension-${entry.id} .extensions-installation`);
                if (!badge) continue;
                const result = installation(entry); badge.textContent = result.label; badge.dataset.installation = result.state;
            }
        };
        search.addEventListener('input', render); render();
        const unavailable = node('p', text('当前服务未提供扩展助手。可查看来源，或在已安装页面管理资源。', 'The extension assistant is unavailable on this server. View the sources or manage resources in the installed tabs.'), { id: 'extensions-assistant-unavailable', role: 'status' });
        panel.append(intro, search, toolbar, feedback, unavailable, grid, empty);
        const invalidate = () => { generation++; view = ''; inventory = null; inventoryState = 'unknown'; renderCards(); };
        window.addEventListener('workspace:settings-closed', invalidate);
        window.addEventListener('workspace:access-locked', invalidate);
        window.addEventListener('storage', event => { if (event.key === 'pi.web.cwd' || event.key === null) void refreshInventory(); });
        document.querySelector('.workspace-settings-content').prepend(panel);
        mountExplore(document.querySelector('.pi-empty-state'));
    });
})();
