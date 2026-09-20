(() => {
    const t = globalThis.PiI18n?.t || (s => s);
    const node = (tag, text, attrs = {}) => { const e = document.createElement(tag); if (text != null) e.textContent = text; for (const [key, value] of Object.entries(attrs)) e.setAttribute(key, value); return e; };
    window.PiExtensionAssistant = {
        create(host) {
            let enabled = false, busy = false, opener, launchGeneration = 0;
            const button = (text, fn, attrs = {}) => { const b = node('button', text, { type: 'button', ...attrs }); b.addEventListener('click', fn); return b; };
            const menu = button('', () => open(), { id: 'pi-extension-assistant-add', role: 'menuitem', tabindex: '-1', hidden: '' });
            const caption = node('span', t('添加能力…')); caption.append(node('small', t('查找、安装和配置技能')));
            menu.append(node('i', '', { class: 'fa-solid fa-puzzle-piece', 'aria-hidden': 'true' }), caption);
            document.getElementById('pi-composer-add-menu').append(menu);
            const dialog = node('dialog', null, { id: 'pi-extension-assistant-dialog', class: 'pi-template-dialog', 'aria-labelledby': 'pi-extension-assistant-title' });
            const header = node('header');
            const heading = node('div'); heading.append(node('h2', t('扩展助手'), { id: 'pi-extension-assistant-title' }), node('p', t('查找能力、了解用法，或解决扩展问题。')));
            const close = button('×', () => dialog.close(), { class: 'pi-extension-close', 'aria-label': t('关闭') });
            header.append(heading, close);
            const target = node('p', '', { class: 'pi-extension-target' });
            const form = node('form'), scopeLabel = node('label', t('安装范围')), scope = node('select', null, { id: 'pi-extension-assistant-scope' });
            scopeLabel.append(scope);
            const needLabel = node('label', t('你需要什么能力？')), need = node('textarea', null, { id: 'pi-extension-assistant-need', rows: '3', maxlength: '4000', placeholder: t('例如：把 Word 资料做成中文汇报 PPT，或粘贴 GitHub / npm 链接') });
            needLabel.append(need);
            const examples = node('div', null, { class: 'pi-extension-examples', 'aria-label': t('需求示例') });
            for (const [title, prompt] of [
                [t('办公文档'), t('帮我查找适合处理中文 Word 和 PDF 的技能，先检查本机已有能力，并比较来源、许可和配置要求。')],
                [t('制作 PPT'), t('我经常制作中文汇报 PPT，希望支持公司模板和可编辑图表。请先查找合适技能并给出安装方案。')],
                [t('分析 Excel'), t('帮我查找整理 Excel 数据、汇总分析和制作图表的技能，先检查兼容性并给出安装方案。')],
                [t('排查扩展'), t('帮我检查已安装的 Packages 和 Skills，找出缺失依赖或加载问题，先说明发现的问题和修复方案。')]
            ]) examples.append(button(title, () => { need.value = prompt; need.focus(); }));
            const status = node('p', '', { role: 'status', 'aria-live': 'polite', id: 'pi-extension-assistant-status' });
            const submit = node('button', null, { type: 'submit', id: 'pi-extension-assistant-create' });
            submit.append(node('span', t('进入助手')), node('i', '', { class: 'fa-solid fa-arrow-right', 'aria-hidden': 'true' }));
            const options = node('div', null, { class: 'pi-extension-options' }); options.append(scopeLabel);
            const location = node('details', null, { class: 'pi-extension-location' });
            location.append(node('summary', t('安装位置与项目')), target); options.append(location);
            const body = node('div', null, { class: 'pi-extension-body' }); body.append(needLabel, examples, options);
            const footer = node('footer', null, { class: 'pi-extension-footer' });
            footer.append(node('p', t('下一步在对话中确认并发送，原草稿会保留。')), submit);
            form.append(body, status, footer);
            dialog.append(header, form); document.body.append(dialog);
            dialog.addEventListener('keydown', e => { if (e.key === 'Escape') e.stopPropagation(); });
            dialog.addEventListener('close', () => { launchGeneration++; if (opener?.isConnected && opener.getClientRects().length) opener.focus(); });
            const banner = node('section', null, { id: 'pi-extension-assistant-banner', hidden: '', 'aria-label': t('扩展助手') });
            const info = node('span'), actions = node('div', null, { class: 'pi-extension-actions' });
            const back = button(t('返回原会话'), () => host.returnTo().catch(e => host.toast(e.message, 'error')), { id: 'pi-extension-assistant-return' });
            actions.append(back, button(t('管理已安装'), () => window.dispatchEvent(new CustomEvent('workspace:open-settings', { detail: { tab: 'packages' } }))));
            banner.append(info, actions); document.querySelector('.pi-composer-wrap').prepend(banner);
            function open(detail = {}) {
                if (!enabled || busy) return;
                const current = host.context();
                const cwd = detail.cwd || current.cwd || current.defaultProject;
                if (!cwd) return host.toast(t('请先选择项目'), 'info');
                opener = document.activeElement;
                dialog.dataset.cwd = cwd;
                scope.replaceChildren(node('option', t('所有项目'), { value: 'global' }));
                if (current.cwd) scope.append(node('option', t('当前项目'), { value: 'project' }));
                scope.value = detail.scope === 'project' && current.cwd ? 'project' : 'global';
                target.textContent = t('安装到运行 Pivane 的机器。项目上下文：{0}', cwd);
                need.value = typeof detail.need === 'string' ? detail.need.slice(0, 4000) : '';
                location.open = false; body.scrollTop = 0;
                status.textContent = ''; submit.disabled = false;
                if (!dialog.open) dialog.showModal();
                need.focus();
            }
            form.addEventListener('submit', async event => {
                event.preventDefault(); if (busy) return;
                busy = true; submit.disabled = true; status.textContent = t('正在创建扩展助手会话…');
                const generation = ++launchGeneration;
                try {
                    const opened = await host.start({ cwd: dialog.dataset.cwd, scope: scope.value, language: globalThis.PiI18n?.locale === 'en' ? 'en' : 'zh-CN', draft: need.value.trim(),
                        canNavigate: () => dialog.open && generation === launchGeneration });
                    if (opened) { dialog.close(); document.getElementById('workspace-settings-close').click(); document.getElementById('pi-input').focus(); }
                    else dialog.close();
                } catch (error) { status.textContent = error.message + ' ' + t('请先核对会话列表，再重新打开助手；不会自动重试。'); }
                finally { busy = false; }
            });
            window.addEventListener('pi:extension-assistant', event => open(event.detail));
            return {
                setEnabled(value) { enabled = value; menu.hidden = !value; },
                update(session) {
                    const profile = session?.assistant;
                    banner.hidden = profile?.kind !== 'extensions';
                    if (banner.hidden) return;
                    info.textContent = t('扩展助手 · {0} · 安装位置：Pivane 部署端', profile.scope === 'project' ? t('当前项目') : t('所有项目'));
                    back.hidden = !profile.returnSessionId;
                }
            };
        }
    };
})();
