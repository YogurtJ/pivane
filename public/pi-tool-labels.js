(() => {
    const t = (s, ...args) => globalThis.PiI18n?.t ? globalThis.PiI18n.t(s, ...args) : s.replace(/\{(\d+)\}/g, (_, i) => args[i] ?? '');
    const text = (s, limit = 4096) => typeof s === 'string' && s.length <= limit ? s : '';
    function update(row) {
        const name = row.dataset.toolName || 'tool', args = row._piToolArgs || {}, result = row._piResult;
        const raw = result?.details?.pi5ToolProvenance;
        const meta = raw?.version === 1 && raw.toolName === name && raw.toolCallId === row.dataset.toolId ? raw : null;
        const source = meta?.source && text(meta.source.source, 1000) && text(meta.source.path) ? meta.source : null;
        const skill = meta?.skill && text(meta.skill.name, 256) && text(meta.skill.path) ? meta.skill : null;
        let title = name, origin = '', info = '';
        const parts = text(args.path).split(/[\\/]/).filter(Boolean);
        if (name === 'read' && skill) { title = t('读取技能 · {0}', skill.name); info = t('匹配本轮的技能清单：{0}', skill.path); }
        else if (name === 'read' && !source && /^SKILL\.md$/i.test(parts.at(-1) || '')) {
            title = t('读取技能文件 · {0}', parts.at(-2) || 'SKILL.md');
            info = t('按文件名识别，未核对技能加载状态。');
        } else if (name === 'extensions_inventory') title = t('检查扩展清单');
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
        if (name === 'extensions_package' && result?.details?.pi5PackageOperation?.status === 'cancelled') {
            row.dataset.state = 'cancelled'; row.querySelector('.pi-tool-status').textContent = t('已取消');
        }
    }
    globalThis.PiToolLabels = { update };
})();
