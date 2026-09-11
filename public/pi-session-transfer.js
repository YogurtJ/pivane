(() => {
    'use strict';
    const LIMIT = 16 * 1024 * 1024;
    const node = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
    };
    class PiSessionTransfer {
        constructor(options) {
            this.options = options; this.enabled = false; this.epoch = 0; this.busy = false;
            this.dialog = node('dialog', undefined, 'pi-transfer-dialog');
            this.dialog.id = 'pi-transfer-dialog';
            this.dialog.setAttribute('aria-labelledby', 'pi-transfer-title');
            const header = node('header');
            this.title = node('h2'); this.title.id = 'pi-transfer-title';
            const close = node('button', '关闭', 'pi-secondary-button'); close.type = 'button';
            close.addEventListener('click', () => this.dialog.close());
            header.append(this.title, close);
            this.body = node('div', undefined, 'pi-transfer-body');
            this.status = node('p', '', 'pi-transfer-status'); this.status.setAttribute('role', 'status');
            this.footer = node('footer');
            this.dialog.append(header, this.body, this.status, this.footer);
            this.dialog.addEventListener('close', () => { this.epoch++; this.body.replaceChildren(); this.footer.replaceChildren(); });
            document.body.append(this.dialog);
        }
        setEnabled(value) { this.enabled = value; document.getElementById('pi-import-session').hidden = !value; }
        begin(title) {
            if (!this.enabled) return false;
            if (this.busy) { this.options.toast('会话文件操作仍在进行，请稍后再试', 'info'); return false; }
            this.epoch++; this.title.textContent = title; this.status.textContent = '';
            this.body.replaceChildren(); this.footer.replaceChildren();
            if (!this.dialog.open) this.dialog.showModal();
            return true;
        }
        button(label, handler) {
            const button = node('button', label, 'pi-primary-button'); button.type = 'button';
            button.addEventListener('click', handler); this.footer.append(button); return button;
        }
        setBusy(value) {
            this.busy = value;
            this.dialog.querySelectorAll('.pi-transfer-body input, .pi-transfer-body select, footer button').forEach(e => { e.disabled = value; });
        }
        openExport(session, cwd) {
            if (!session || session.ephemeral || !this.begin('导出记录')) return false;
            const epoch = this.epoch;
            this.body.append(node('p', session.name || session.firstMessage || '未命名会话', 'pi-transfer-session'));
            const label = node('label', '文件格式');
            const format = node('select'); format.id = 'pi-transfer-format';
            for (const [value, title] of [['html', 'HTML · 独立阅读'], ['jsonl', 'Pi JSONL · 当前分支，可导入继续']]) {
                const option = node('option', title); option.value = value; format.append(option);
            }
            label.append(format);
            const scope = node('p', '', 'pi-transfer-scope');
            const update = () => { scope.textContent = format.value === 'html'
                ? '包含会话树中已保存的历史分支、压缩前记录、思考与工具内容，以及原生导出携带的系统提示和工具定义。可离线打开；范围不限于网页当前显示的正文。'
                : '仅导出当前活动分支，保留该分支上的消息、工具和摘要记录，供 Pi 导入继续。其他分支不包含在内，这不是完整会话树备份。'; };
            format.addEventListener('change', update); update();
            this.body.append(label, scope, node('p', '会话空闲时可导出，最大 64 MiB。记录可能包含路径、代码和对话中出现的私密内容，分享前请检查。项目文件和运行环境不随记录打包。'));
            this.button('下载记录', async () => {
                if (this.busy) return;
                this.setBusy(true); this.status.textContent = '正在准备下载…';
                const selected = format.value;
                try {
                    const response = await (window.WorkspaceAccess?.fetch || fetch)(`/api/pi/sessions/${encodeURIComponent(session.id)}/export`, {
                        method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'Content-Type': 'application/json', ...this.options.headers() },
                        body: JSON.stringify({ cwd, format: selected })
                    });
                    if (!response.ok) { const error = await response.json(); throw new Error(error.error || '导出失败'); }
                    const blob = await response.blob();
                    if (epoch !== this.epoch) return;
                    const url = URL.createObjectURL(blob), link = node('a');
                    link.href = url; link.download = `pi-session-${session.id}.${selected}`;
                    document.body.append(link); link.click(); link.remove();
                    setTimeout(() => URL.revokeObjectURL(url), 60000);
                    this.status.textContent = '已发起下载，可在浏览器下载列表中查看。';
                } catch (error) { if (epoch === this.epoch) this.status.textContent = error.message; }
                finally { this.setBusy(false); }
            });
            return true;
        }
        openImport(cwd) {
            if (!this.begin('导入 Pi 会话')) return false;
            const epoch = this.epoch;
            this.body.append(node('p', '选择 Pi v2/v3 JSONL 文件，导入到目标项目下的独立新线程。已有线程保留；导入后不会自动发送消息或切换当前会话。'));
            const projectLabel = node('label', '目标项目');
            const project = node('select'); project.id = 'pi-transfer-project';
            const paths = [...new Set([cwd, ...this.options.projects().map(p => p.cwd)].filter(Boolean))];
            for (const value of paths) { const option = node('option', value); option.value = value; project.append(option); }
            const other = node('option', '其他项目路径…'); other.value = ''; project.append(other);
            projectLabel.append(project);
            const pathLabel = node('label', '项目绝对路径');
            const customPath = node('input'); customPath.id = 'pi-transfer-path'; customPath.type = 'text'; customPath.autocomplete = 'off';
            customPath.placeholder = '选择允许范围内已存在的项目目录'; pathLabel.append(customPath);
            pathLabel.hidden = Boolean(project.value);
            project.addEventListener('change', () => { pathLabel.hidden = Boolean(project.value); });
            const fileLabel = node('label', 'Pi 会话文件（最大 16 MiB）');
            const file = node('input'); file.id = 'pi-transfer-file'; file.type = 'file'; file.accept = '.jsonl'; fileLabel.append(file);
            this.body.append(projectLabel, pathLabel, fileLabel, node('p', 'HTML 和其他 Agent 的会话格式暂不支持。消息中的旧路径保留原文，实际工作目录使用所选项目；项目文件、凭据和运行环境需要另行准备。'));
            const submit = this.button('导入为新线程', async () => {
                if (this.busy) return;
                const selected = file.files[0], target = project.value || customPath.value.trim();
                if (!target || !selected) { this.status.textContent = '请选择目标项目和会话文件。'; return; }
                if (!/\.jsonl$/i.test(selected.name) || selected.size > LIMIT || !selected.size) { this.status.textContent = '请选择不超过 16 MiB 的非空 .jsonl 文件。'; return; }
                this.setBusy(true); this.status.textContent = '正在读取并校验会话…';
                let submitted = false;
                try {
                    const content = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
                    if (epoch !== this.epoch) return;
                    const requestId = `import-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
                    submitted = true; this.status.textContent = '正在导入…';
                    const result = await this.options.apiFetch('/api/pi/sessions/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120000), body: JSON.stringify({ cwd: target, content, requestId }) });
                    try { await this.options.refresh(result.session.cwd); }
                    catch { this.options.toast('会话已导入，线程列表暂未刷新，请稍后刷新列表', 'info'); }
                    if (epoch !== this.epoch) { this.options.toast('Pi 会话已导入为新线程', 'success'); return; }
                    this.body.replaceChildren(node('p', `已导入到 ${result.session.cwd}`), node('p', result.session.name || result.session.firstMessage || '未命名会话'));
                    this.status.textContent = '新线程已保存。可以继续当前工作，或打开导入的线程。'; this.footer.replaceChildren();
                    this.button('打开新线程', async () => {
                        this.dialog.close();
                        try { await this.options.open(result.session); } catch (error) { this.options.toast(error.message, 'error'); }
                    });
                } catch (error) {
                    if (epoch === this.epoch) {
                        this.status.textContent = submitted ? `${error.message}。未自动重试；如遇断线或响应不明，请先刷新目标项目核对是否已导入。` : '文件读取失败，请确认文件是 UTF-8 编码。';
                        // A submitted import is never automatically replayed, including after an uncertain response.
                        if (submitted) submit.remove();
                    }
                } finally { this.setBusy(false); }
            });
            return true;
        }
    }
    window.PiSessionTransfer = PiSessionTransfer;
})();
