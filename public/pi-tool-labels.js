(() => {
    const t = (s, ...args) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(s, ...args) : s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
    const text = (s, limit = 4096) => typeof s === 'string' && s.length <= limit ? s : '';
    // pi-subagents tools. Titles summarize the call; the raw tool name stays in the detail line.
    const role = value => {
        const id = text(value, 128);
        return id ? globalThis.PiSubagentSettings?.roleName?.(id) || id : '';
    };
    const withRole = (label, value) => role(value) ? `${label} · ${role(value)}` : label;
    const SUBAGENT_ACTIONS = {
        status: '查看子 Agent 状态', list: '列出子 Agent 角色', get: '查看子 Agent 角色', models: '查看子 Agent 可用模型',
        steer: '引导子 Agent', resume: '继续子 Agent', stop: '停止子 Agent', interrupt: '中断子 Agent', 'children.list': '列出子 Agent 运行',
        guide: '读取子 Agent 使用说明', doctor: '诊断子 Agent 环境', validate: '检查子 Agent 工作流', create: '创建子 Agent 角色',
        update: '修改子 Agent 角色', delete: '删除子 Agent 角色', 'inspector.command': '查看子 Agent 检查命令'
    };
    function subagentTitle(name, args) {
        if (name === 'subagents_enable') return t('启用子 Agent 工具');
        if (name === 'bg_wait') return args.nonBlocking ? t('订阅后台任务完成提醒') : t('等待后台任务');
        if (name === 'subagent_supervisor') {
            return t(({ reply: '回复子 Agent 请示', pending: '查看待回复的子 Agent 请示', status: '查看子 Agent 请示状态', list: '列出子 Agent 请示' })[args.action] || '处理子 Agent 请示');
        }
        const action = text(args.action, 80);
        if (action) return Object.hasOwn(SUBAGENT_ACTIONS, action) ? withRole(t(SUBAGENT_ACTIONS[action]), action === 'status' ? '' : args.agent) : t('子 Agent 操作 · {0}', action);
        const background = args.async === true;
        if (args.workflow || args.workflowScript || args.workflowScriptPath) return t(background ? '后台运行子 Agent 工作流' : '运行子 Agent 工作流');
        if (Array.isArray(args.tasks)) return t(background ? '后台并行运行 {0} 个子 Agent' : '并行运行 {0} 个子 Agent', args.tasks.length);
        if (Array.isArray(args.chain)) return t(background ? '后台依次运行 {0} 个子 Agent' : '依次运行 {0} 个子 Agent', args.chain.length);
        return withRole(t(background ? '后台启动子 Agent' : '运行子 Agent'), args.agent);
    }
    function update(row) {
        const name = row.dataset.toolName || 'tool', args = row._piToolArgs || {}, result = row._piResult;
        const raw = result?.details?.pivaneToolProvenance ?? result?.details?.pi5ToolProvenance;
        const meta = raw?.version === 1 && raw.toolName === name && raw.toolCallId === row.dataset.toolId ? raw : null;
        const source = meta?.source && text(meta.source.source, 1000) && text(meta.source.path) ? meta.source : null;
        const skill = meta?.skill && text(meta.skill.name, 256) && text(meta.skill.path) ? meta.skill : null;
        let title = name, origin = '', info = '';
        const parts = text(args.path).split(/[\\/]/).filter(Boolean);
        if (name === 'read' && skill) { title = t('读取技能 · {0}', skill.name); info = t('匹配本轮的技能清单：{0}', skill.path); }
        else if (name === 'read' && !source && /^SKILL\.md$/i.test(parts.at(-1) || '')) {
            title = t('读取技能文件 · {0}', parts.at(-2) || 'SKILL.md');
            info = t('按文件名识别，未核对技能加载状态。');
        } else if (name === 'update_plan') title = t('更新任务计划');
        else if (name === 'agent_message') {
            const peer = text(result?.details?.to?.name, 160) || (text(args.to, 160) ? `${args.to.slice(0, 8)}…` : '');
            title = args.action === 'threads' ? t('查看可联系的线程') : args.action === 'status' ? t('查看消息投递状态')
                : peer ? t(args.replyTo ? '回复 Agent 消息 · {0}' : '发送 Agent 消息 · {0}', peer) : t('发送 Agent 消息');
        } else if (name === 'agent_thread') {
            title = args.action === 'create' && text(args.title, 120) ? t('新建任务线程 · {0}', args.title) : args.action === 'status' ? t('查看任务线程状态')
                : args.action === 'result' ? t('读取任务结果') : args.action === 'models' ? t('查看可用模型') : title;
        }
        else if (['subagent', 'subagent_supervisor', 'subagents_enable', 'bg_wait'].includes(name)) title = subagentTitle(name, args);
        else if (name === 'extensions_inventory') title = t('检查扩展清单');
        else if (name === 'extensions_package') {
            title = ({ install: t('安装扩展包'), update: t('更新扩展包'), remove: t('移除扩展包') })[args.action] || t('管理扩展包');
            if (text(args.source, 1000)) title += ' · ' + args.source;
        }
        if (source) {
            origin = source.origin === 'package' ? t('来自 {0}', source.source.replace(/^npm:/, '')) : t('扩展工具');
            info = t('调用时注册的来源：{0}', source.source) + '\n' + source.path;
        }
        const heading = row.querySelector('summary > strong'); if (!heading) return;
        heading.textContent = title; heading.title = title;
        let badge = row.querySelector('.pi-tool-source');
        if (origin) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'pi-tool-source'; heading.after(badge); }
            badge.textContent = origin; badge.title = origin;
        } else badge?.remove();
        let detail = row.querySelector('.pi-tool-provenance');
        if (title !== name || info) {
            if (!detail) { detail = document.createElement('p'); detail.className = 'pi-tool-provenance'; row.querySelector('.pi-tool-detail')?.prepend(detail); }
            detail.textContent = t('原始工具：{0}', name) + (info ? '\n' + info : '');
        } else detail?.remove();
        if (name === 'extensions_package' && (result?.details?.pivanePackageOperation ?? result?.details?.pi5PackageOperation)?.status === 'cancelled') {
            row.dataset.state = 'cancelled'; row.querySelector('.pi-tool-status').textContent = t('已取消');
        }
    }
    globalThis.PiToolLabels = { update };
})();
