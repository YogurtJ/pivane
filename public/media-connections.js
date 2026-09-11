(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    document.addEventListener('DOMContentLoaded', () => {
        const dialog = document.getElementById('lab-connections-dialog');
        if (!dialog) return;
        const content = document.getElementById('mc-content'), footer = document.getElementById('mc-footer');
        const title = document.getElementById('mc-title'), back = document.getElementById('mc-back');
        let snapshot = null, epoch = 0, kind = 'image', busy = false;
        const labels = { image: translateUi("图像"), video: translateUi("视频"), tts: translateUi("语音") };
        const node = (tag, className = '', text = '') => { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; };
        const clone = value => JSON.parse(JSON.stringify(value));
        function button(label, handler, primary = false) { const el = node('button', primary ? 'lab-primary' : 'lab-secondary', label); el.type = 'button'; el.addEventListener('click', handler); return el; }
        async function api(path = '', body, method = body ? 'POST' : 'GET') {
            const token = sessionStorage.getItem('pi.web.token');
            let response;
            try { response = await (window.WorkspaceAccess?.fetch || fetch)('/api/pi/media/lab' + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined }); }
            catch { throw new Error(translateUi("连接中断；请刷新服务列表核对是否已保存。")); }
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(translateUi(data.error || `HTTP ${response.status}`));
            return data;
        }
        function changed(modelId) { window.dispatchEvent(new CustomEvent('media-lab:configured', { detail: { modelId } })); }
        function shell(heading, onBack) {
            epoch++; title.textContent = heading; content.replaceChildren(); footer.replaceChildren(); content.scrollTop = 0;
            back.hidden = !onBack; back.onclick = onBack || null;
            return epoch;
        }
        function message(text, error = false, container = content) { const el = node('p', error ? 'lab-error' : 'lab-muted', text); container.append(el); return el; }
        function field(parent, label, type = 'text', value = '', options = {}) {
            const wrapper = node('label', 'lab-field' + (options.wide ? ' wide' : ''));
            wrapper.append(node('span', '', label));
            let input;
            if (type === 'select') {
                input = node('select');
                for (const option of options.choices || []) input.append(new Option(typeof option === 'string' ? option : option.label, typeof option === 'string' ? option : option.value));
            } else if (type === 'textarea') { input = node('textarea', options.code ? 'mc-code' : ''); input.rows = options.rows || 4; }
            else { input = node('input'); input.type = type; }
            input.setAttribute('aria-label', label);
            if (type === 'checkbox') { input.checked = Boolean(value); wrapper.classList.add('boolean'); }
            else input.value = value ?? '';
            input.required = Boolean(options.required);
            if (options.placeholder) input.placeholder = options.placeholder;
            if (options.min !== undefined) input.min = options.min;
            if (options.max !== undefined) input.max = options.max;
            if (options.step !== undefined) input.step = options.step;
            if (options.maxLength) input.maxLength = options.maxLength;
            if (options.readOnly) input.readOnly = true;
            wrapper.append(input);
            if (options.help) wrapper.append(node('small', '', options.help));
            parent.append(wrapper); return { input, wrapper };
        }
        function valid(form) {
            for (const el of form.querySelectorAll('input,textarea,select')) {
                if (el.closest('[hidden]') || el.checkValidity()) continue;
                for (let parent = el.parentElement; parent && parent !== form; parent = parent.parentElement) if (parent.tagName === 'DETAILS') parent.open = true;
                el.reportValidity(); return false;
            }
            return true;
        }
        function stamp() { return { expectedRevision: snapshot.revision, confirmed: true }; }
        // Only the owning view receives a delayed error; the server revision remains authoritative.
        async function action(element, task) {
            if (busy) { message(translateUi("上一次接入操作仍在进行，请稍候。")); return; }
            const view = epoch;
            busy = true; element.disabled = true;
            try { await task(); }
            catch (error) { if (dialog.open && epoch === view) message(error.message, true); }
            finally { busy = false; element.disabled = false; }
        }
        async function reload() { snapshot = await api('/connections'); return snapshot; }
        async function showOverview() {
            const view = shell(translateUi("媒体服务与模型")); message(translateUi("正在读取服务"));
            try { await reload(); if (!dialog.open || view !== epoch) return; renderOverview(); }
            catch (error) { if (dialog.open && view === epoch) { content.replaceChildren(); message(error.message, true); footer.append(button(translateUi("重试"), showOverview)); } }
        }
        function keyLabel(provider) {
            return provider.auth.mode === 'none' ? translateUi("无需 Key") : provider.keyNeedsRebind ? translateUi("地址已更换 · 需要重新保存 Key") : provider.keyConfigured ? translateUi("Key 已保存") : translateUi("尚未配置 Key");
        }
        function renderOverview() {
            shell(translateUi("媒体服务与模型"));
            message(translateUi("选择服务，添加自己的图像、视频或语音模型。"));
            if (!snapshot.providers.length) message(translateUi("还没有媒体服务。从常用服务开始，或接入自己的兼容 API。"));
            const list = node('div', 'mc-provider-list');
            for (const provider of snapshot.providers) {
                const card = node('article', 'mc-card'); card.append(node('h3', '', provider.name), node('p', 'mc-url', provider.baseUrl), node('p', 'lab-muted', keyLabel(provider)));
                const actions = node('div', 'mc-actions');
                actions.append(button(translateUi("管理模型（{0}）", provider.models.length), () => showProvider(provider.id), true), button(translateUi("编辑服务"), () => editProvider(provider.id)));
                card.append(actions); list.append(card);
            }
            content.append(list); footer.append(button(translateUi("刷新列表"), showOverview), button(translateUi("新增服务"), () => editProvider(), true));
        }
        function providerById(id) { return snapshot.providers.find(item => item.id === id); }
        function showProvider(id) {
            const provider = providerById(id); if (!provider) return renderOverview();
            const view = shell(provider.name, renderOverview);
            message(provider.baseUrl + ' · ' + keyLabel(provider));
            const probes = node('div', 'mc-actions'), result = node('div');
            const probe = button(translateUi("连接测试"), () => action(probe, async () => {
                const data = await api(`/providers/${encodeURIComponent(id)}/probe`, { mode: 'connection', confirmed: true });
                if (view !== epoch) return; result.replaceChildren(); message(data.message, !data.ok, result);
            }));
            const discover = button(translateUi("读取模型列表"), () => action(discover, async () => {
                const data = await api(`/providers/${encodeURIComponent(id)}/probe`, { mode: 'models', confirmed: true });
                if (view !== epoch) return; result.replaceChildren(); message(data.message, !data.ok, result);
                const picker = node('div', 'mc-discovery');
                for (const model of data.models || []) picker.append(button(model.name === model.id ? model.id : `${model.name} · ${model.id}`, () => editModel(id, null, { remoteModel: model.id, name: model.name })));
                result.append(picker);
            }));
            probes.append(probe, discover, button(translateUi("编辑服务 / Key"), () => editProvider(id))); content.append(probes, result);
            const list = node('div', 'mc-model-list');
            for (const model of provider.models) {
                const row = node('article', 'mc-card'); row.append(node('h3', '', model.name), node('p', 'lab-muted', `${labels[model.kind]} · ${model.remoteModel}`));
                const actions = node('div', 'mc-actions');
                const remove = button(translateUi("删除模型"), () => action(remove, async () => {
                    if (!confirm(translateUi("删除“{0}”的接入配置？生成记录和媒体文件会保留。", model.name))) return;
                    await api(`/providers/${encodeURIComponent(id)}/models/${encodeURIComponent(model.id)}`, stamp(), 'DELETE');
                    await reload(); changed(); if (view === epoch) showProvider(id);
                }));
                actions.append(button(translateUi("使用"), () => { changed(`media:${id}:${model.id}`); dialog.close(); }, true), button(translateUi("编辑模型"), () => editModel(id, model.id)), remove);
                row.append(actions); list.append(row);
            }
            if (!provider.models.length) message(translateUi("还没有配置可生成的媒体模型。可以手动填写模型 ID，或读取服务提供的模型列表。"), false, list);
            content.append(list); footer.append(button(translateUi("添加模型"), () => editModel(id), true));
        }
        function editProvider(id) {
            const existing = id ? providerById(id) : null;
            const view = shell(existing ? translateUi("编辑媒体服务") : translateUi("新增媒体服务"), () => existing ? showProvider(id) : renderOverview());
            const form = node('form', 'lab-fields'); form.addEventListener('submit', event => { event.preventDefault(); save.click(); });
            if (!existing && snapshot.providerTemplates?.length) {
                const presets = node('div', 'mc-presets');
                const choose = field(presets, translateUi("常用服务"), 'select', '', { choices: [{ value: '', label: translateUi("自定义 / 兼容 API") }, ...snapshot.providerTemplates.map(item => ({ value: item.id, label: translateUi(item.name) }))], help: translateUi("选好服务后填入 Key；地址可改为自己的代理或区域地址。") }).input;
                choose.addEventListener('change', () => {
                    const preset = snapshot.providerTemplates.find(item => item.id === choose.value);
                    if (!preset) return;
                    fields.name.value = preset.name; fields.url.value = preset.baseUrl;
                    fields.auth.value = preset.auth.mode; header.input.value = preset.auth.header || 'x-api-key'; prefix.input.value = preset.auth.prefix || '';
                    fields.probe.value = preset.probePath; fields.models.value = preset.modelsPath;
                    fields.origins.value = preset.downloadOrigins.join('\n'); authView();
                });
                content.append(presets);
            }
            const fields = {};
            fields.name = field(form, translateUi("服务名称"), 'text', existing?.name, { required: true, maxLength: 200 }).input;
            const internalId = field(form, translateUi("服务 ID"), 'text', existing?.id || `service-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, { required: true, readOnly: Boolean(existing), maxLength: 80 }); fields.id = internalId.input;
            fields.url = field(form, 'Base URL', 'url', existing?.baseUrl, { required: true, wide: true, placeholder: 'https://api.example.com/v1', maxLength: 2000 }).input;
            fields.auth = field(form, translateUi("认证方式"), 'select', existing?.auth.mode || 'bearer', { choices: [{ value: 'bearer', label: 'Bearer API Key' }, { value: 'header', label: translateUi("自定义 Key Header") }, { value: 'none', label: translateUi("无需 Key") }] }).input;
            const key = field(form, 'API Key', 'password', '', { maxLength: 32768, help: existing ? keyLabel(existing) + translateUi("；留空保留已保存的 Key。") : translateUi("Key 仅保存到此实例，不会回显。") });
            key.input.autocomplete = 'new-password';
            const header = field(form, translateUi("Key Header 名称"), 'text', existing?.auth.header || 'x-api-key', { maxLength: 80 });
            const prefix = field(form, translateUi("Key 前缀（可留空）"), 'text', existing?.auth.prefix || '', { maxLength: 40, placeholder: translateUi("例如 Token 后加一个空格") });
            const details = node('details', 'mc-details wide'); details.append(node('summary', '', translateUi("高级连接设置")));
            const advanced = node('div', 'lab-fields');
            fields.probe = field(advanced, translateUi("连接测试路径（GET）"), 'text', existing?.probePath ?? '/models', { maxLength: 2000 }).input;
            fields.models = field(advanced, translateUi("模型列表路径（GET，可留空）"), 'text', existing?.modelsPath ?? '/models', { maxLength: 2000 }).input;
            fields.origins = field(advanced, translateUi("额外下载域名"), 'textarea', (existing?.downloadOrigins || []).join('\n'), { wide: true, rows: 3, help: translateUi("每行一个完整来源，例如 https://cdn.example.com。服务本身的来源已允许；Key 不会发送到其他来源。") }).input;
            advanced.prepend(internalId.wrapper, fields.auth.closest('label'), header.wrapper, prefix.wrapper);
            details.append(advanced); form.append(details); content.append(form);
            function authView() { key.wrapper.hidden = fields.auth.value === 'none'; header.wrapper.hidden = prefix.wrapper.hidden = fields.auth.value !== 'header'; }
            fields.auth.addEventListener('change', authView); authView();
            const save = button(translateUi("保存服务"), () => action(save, async () => {
                if (!valid(form)) return;
                const auth = { mode: fields.auth.value };
                if (auth.mode === 'header') Object.assign(auth, { header: header.input.value, prefix: prefix.input.value });
                const provider = { id: fields.id.value.trim(), name: fields.name.value.trim(), baseUrl: fields.url.value.trim(), auth,
                    probePath: fields.probe.value, modelsPath: fields.models.value, downloadOrigins: fields.origins.value.split(/\n/).map(value => value.trim()).filter(Boolean) };
                if (!confirm(translateUi("保存媒体服务“{0}”（{1}）？确认生成时，参数将发送到此服务。", provider.name, provider.baseUrl))) return;
                const newKey = auth.mode === 'none' ? '' : key.input.value.trim(); key.input.value = '';
                let providerSaved = false;
                try {
                    snapshot = { ...snapshot, ...await api('/providers', { ...stamp(), provider, create: !existing }) }; providerSaved = true;
                    if (newKey) snapshot = { ...snapshot, ...await api(`/providers/${encodeURIComponent(provider.id)}/key`, { ...stamp(), apiKey: newKey }) };
                    changed(); if (view === epoch) showProvider(provider.id);
                } catch (error) {
                    if (providerSaved) {
                        await reload(); changed();
                        if (view === epoch) { editProvider(provider.id); message(translateUi("服务已保存；Key 状态需要核对。") + error.message, true); }
                    } else throw error;
                }
            }), true);
            footer.append(save);
            if (existing) {
                const removeKey = button(translateUi("移除 Key"), () => action(removeKey, async () => {
                    if (!confirm(translateUi("移除这个媒体服务保存的 Key？"))) return;
                    await api(`/providers/${encodeURIComponent(id)}/key`, stamp(), 'DELETE'); await reload(); changed(); if (view === epoch) editProvider(id);
                }));
                const remove = button(translateUi("删除服务"), () => action(remove, async () => {
                    if (!confirm(translateUi("删除“{0}”、其接入模型和 Key？生成记录及媒体文件会保留。", existing.name))) return;
                    await api(`/providers/${encodeURIComponent(id)}`, { ...stamp(), removeModels: true }, 'DELETE'); await reload(); changed(); if (view === epoch) renderOverview();
                }));
                footer.prepend(remove, removeKey);
            }
        }
        function pathText(value) { return (value || []).every(part => !String(part).includes('.')) ? (value || []).join('.') : JSON.stringify(value); }
        function parsePath(value) {
            if (!value.trim()) return [];
            if (value.trim().startsWith('[')) return JSON.parse(value);
            return value.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part);
        }
        function preferredTemplate(provider, mediaKind) {
            const host = new URL(provider.baseUrl).hostname;
            const preferred = mediaKind === 'video' ? (host.endsWith('volces.com') ? 'ark-video' : 'async-video')
                : mediaKind === 'tts' ? (host === 'dashscope.aliyuncs.com' ? 'qwen-speech' : 'openai-speech')
                    : host === 'generativelanguage.googleapis.com' ? 'gemini-image' : host.endsWith('volces.com') ? 'ark-image'
                        : 'gpt-image';
            return snapshot.templates.find(item => item.id === preferred) || snapshot.templates.find(item => item.model.kind === mediaKind) || snapshot.templates[0];
        }
        function editModel(providerId, modelId, initial = {}, preservedDocs = '', notice = '') {
            const provider = providerById(providerId);
            const existing = modelId ? provider.models.find(model => model.id === modelId) : null;
            const defaultTemplate = preferredTemplate(provider, initial.kind || existing?.kind || kind);
            const current = clone({ ...(existing || defaultTemplate.model), ...initial });
            if (!existing && !initial.http && defaultTemplate.id === 'gemini-image') current.remoteModel = current.remoteModel.replace(/^models\//, '');
            const view = shell(existing ? translateUi("编辑媒体模型") : translateUi("添加媒体模型"), () => showProvider(providerId));
            let formRevision = 0, reading = false;
            const form = node('form', 'lab-fields'); form.addEventListener('submit', event => { event.preventDefault(); save.click(); });
            form.addEventListener('input', () => { formRevision++; });
            const fields = {};
            fields.name = field(form, translateUi("显示名称"), 'text', existing || initial.http ? current.name : '', { placeholder: translateUi("可留空，使用模型 ID"), maxLength: 200 }).input;
            fields.remote = field(form, translateUi("模型 ID（服务端）"), 'text', current.remoteModel, { required: true, maxLength: 500 }).input;
            fields.kind = field(form, translateUi("媒体类型"), 'select', current.kind, { choices: Object.entries(labels).map(([value, label]) => ({ value, label })) }).input;
            const templates = [{ value: '', label: translateUi("自定义 / 保留当前配置") }, ...[...snapshot.templates].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended))).map(template => ({ value: template.id, label: translateUi(template.name) }))];
            const matchedTemplate = snapshot.templates.find(item => JSON.stringify(item.model.http) === JSON.stringify(current.http));
            fields.template = field(form, translateUi("协议模板"), 'select', matchedTemplate?.id || '', { choices: templates }).input;
            form.prepend(fields.kind.closest('label'), fields.template.closest('label'));
            const protocolSummary = node('p', 'mc-protocol-summary wide', notice || (matchedTemplate?.help ? translateUi(matchedTemplate.help) : '') || translateUi("常用协议已填好。填写服务端模型 ID 后即可保存，特殊参数可交给 Agent 配置。"));
            form.append(protocolSummary);
            fields.kind.addEventListener('change', () => {
                const selected = preferredTemplate(provider, fields.kind.value);
                editModel(providerId, modelId, { ...clone(selected.model), id: current.id, name: fields.name.value, remoteModel: fields.remote.value }, docs.input.value, selected.help ? translateUi(selected.help) : translateUi("已切换媒体类型，请核对模型 ID。"));
            });
            fields.template.addEventListener('change', () => {
                const selected = snapshot.templates.find(template => template.id === fields.template.value); if (!selected) return;
                editModel(providerId, modelId, { ...clone(selected.model), id: current.id, name: fields.name.value, remoteModel: fields.remote.value }, docs.input.value, selected.help ? translateUi(selected.help) : translateUi("模板已填入，可根据所选模型的要求调整。"));
            });
            const agentBox = node('details', 'mc-details wide'); agentBox.append(node('summary', '', translateUi("让 Agent 根据 API 文档生成接入草稿")));
            const docs = field(agentBox, translateUi("API 文档或请求/响应示例"), 'textarea', preservedDocs, { rows: 6, maxLength: 64000, help: translateUi("粘贴或选择文档文件，不要包含 Key。Agent 只生成配置草稿，保存和生成由你确认。") });
            const fileLabel = node('label', 'mc-file', translateUi("选择文档文件"));
            const file = node('input'); file.type = 'file'; file.accept = '.md,.txt,.json,.yaml,.yml,.html'; file.setAttribute('aria-label', translateUi("选择 API 文档文件")); fileLabel.append(file); agentBox.append(fileLabel);
            const draftStatus = node('p', 'lab-muted');
            const plan = button(translateUi("生成接入草稿"), () => action(plan, async () => {
                if (reading || !docs.input.value.trim()) { docs.input.focus(); return; }
                const captured = formRevision;
                const result = await api('/connection-plan', { providerId, kind: fields.kind.value, remoteModel: fields.remote.value,
                    documentation: docs.input.value, cwd: localStorage.getItem('pi.web.cwd') || undefined });
                if (epoch !== view || !dialog.open || formRevision !== captured) { if (dialog.open && epoch === view) draftStatus.textContent = translateUi("编辑内容已变化，未覆盖当前草稿。"); return; }
                if (result.draft.unsupported?.length) { draftStatus.textContent = result.draft.summary + '：' + result.draft.unsupported.join('；'); return; }
                editModel(providerId, modelId, { ...result.draft.model, id: current.id || result.draft.model.id }, docs.input.value,
                    `${result.draft.summary} · ${result.plannerModel.name}${result.fallbackUsed ? translateUi("（备用模型）") : ''}。` + result.draft.warnings.join('；') + translateUi(" 尚未保存，可继续修改。"));
            }));
            let fileRevision = 0;
            file.addEventListener('change', async () => {
                const selected = file.files[0]; file.value = ''; if (!selected) return;
                const token = ++fileRevision, captured = ++formRevision; reading = true; plan.disabled = true;
                try {
                    if (selected.size > 64000) throw new Error(translateUi("文档文件请控制在 64KB 以内。"));
                    const value = new TextDecoder('utf-8', { fatal: true }).decode(await selected.arrayBuffer());
                    if (token !== fileRevision || epoch !== view || formRevision !== captured) return;
                    docs.input.value = value; formRevision++;
                } catch (error) { if (view === epoch) draftStatus.textContent = error.message || translateUi("文档必须是 UTF-8 文本。"); }
                finally { if (token === fileRevision) { reading = false; plan.disabled = false; } }
            });
            agentBox.append(plan, draftStatus); form.append(agentBox);
            const protocol = node('details', 'mc-details wide'); protocol.append(node('summary', '', translateUi("高级：接口、输出与轮询")));
            const protocolFields = node('div', 'lab-fields'); protocol.append(protocolFields);
            fields.path = field(protocolFields, translateUi("生成接口路径（POST）"), 'text', current.http.path, { required: true, wide: true, help: translateUi("追加到 {0} 后，不重复其 /v1 前缀。可用 {model} 或 {param:voice} 插入模型/参数。", provider.baseUrl), maxLength: 2000 }).input;
            fields.response = field(protocolFields, translateUi("结果形式"), 'select', current.http.response.type, { choices: [{ value: 'image-json', label: translateUi("标准图像响应（自动识别）") }, { value: 'base64', label: translateUi("JSON 中的 base64") }, { value: 'url', label: translateUi("JSON 中的下载 URL") }, { value: 'binary', label: translateUi("直接返回媒体文件") }] }).input;
            fields.mime = field(protocolFields, translateUi("文件格式"), 'select', current.http.response.mimeType, { choices: ['auto','image/png','image/jpeg','image/webp','video/mp4','audio/wav','audio/mpeg'] }).input;
            const output = field(protocolFields, translateUi("结果字段路径"), 'text', pathText(current.http.response.path), { wide: true, placeholder: 'data.0.b64_json', help: translateUi("用点分隔字段和数组序号，也可填写 JSON 路径数组。"), maxLength: 2000 });
            const asynchronous = field(protocolFields, translateUi("异步任务：提交后查询状态"), 'checkbox', Boolean(current.http.poll), { wide: true });
            const polling = node('div', 'lab-fields wide mc-poll');
            const poll = current.http.poll || { idPath: ['id'], path: '/tasks/{id}', statusPath: ['status'], pending: ['queued','running'], succeeded: ['succeeded'], failed: ['failed','cancelled'], intervalMs: 5000 };
            fields.idPath = field(polling, translateUi("任务 ID 字段"), 'text', pathText(poll.idPath), { maxLength: 2000 }).input;
            fields.pollMode = field(polling, translateUi("查询地址来源"), 'select', poll.urlPath ? 'response' : 'path', { choices: [{ value: 'path', label: translateUi("路径模板") }, { value: 'response', label: translateUi("提交响应中的 URL") }] }).input;
            const pollPath = field(polling, translateUi("查询路径（GET）"), 'text', poll.path || '/tasks/{id}', { wide: true, help: translateUi("使用 {id} 插入任务 ID；查询始终位于当前服务来源。"), maxLength: 2000 });
            const pollUrl = field(polling, translateUi("查询 URL 字段"), 'text', pathText(poll.urlPath || ['urls','get']), { wide: true, maxLength: 2000 });
            fields.statusPath = field(polling, translateUi("任务状态字段"), 'text', pathText(poll.statusPath), { maxLength: 2000 }).input;
            fields.interval = field(polling, translateUi("查询间隔（秒）"), 'number', poll.intervalMs / 1000, { min: 1, max: 60, step: 1 }).input;
            for (const [key, label] of [['pending',translateUi("处理中状态")],['succeeded',translateUi("成功状态")],['failed',translateUi("失败状态")]]) fields[key] = field(polling, label, 'text', poll[key].every(value => typeof value === 'string') ? poll[key].join(', ') : JSON.stringify(poll[key]), { wide: true, help: translateUi("多个字符串用英文逗号分隔；布尔值或数字用 JSON 数组，如 [true] 或 [false,null]。"), maxLength: 2000 }).input;
            protocolFields.append(polling);
            fields.timeout = field(protocolFields, translateUi("本次请求最长等待（秒）"), 'number', current.http.timeoutMs / 1000, { min: 1, max: 1800, step: 1, help: translateUi("超时不代表远端任务已取消；不会自动重新提交。"), wide: true }).input;
            const advanced = node('details', 'mc-details wide'); advanced.append(node('summary', '', translateUi("高级：参数定义与请求映射")));
            fields.parameters = field(advanced, translateUi("参数定义 JSON"), 'textarea', JSON.stringify(current.parameters, null, 2), { rows: 10, code: true, maxLength: 64000 }).input;
            fields.body = field(advanced, translateUi("请求体模板 JSON"), 'textarea', JSON.stringify(current.http.body, null, 2), { rows: 8, code: true, maxLength: 32000, help: translateUi("{$param:\"字段\"} 引用参数；{$model:true} 引用模型 ID；{$params:true} 引用全部参数。") }).input;
            form.append(protocol, advanced);
            fields.instructions = field(advanced, translateUi("模型使用要求"), 'textarea', current.instructions, { rows: 3, wide: true, maxLength: 64000, help: translateUi("生成方案时，Agent 会读取这些要求。") }).input;
            content.append(form);
            function protocolView() {
                output.wrapper.hidden = fields.response.value === 'binary'; polling.hidden = !asynchronous.input.checked;
                pollPath.wrapper.hidden = fields.pollMode.value !== 'path'; pollUrl.wrapper.hidden = fields.pollMode.value !== 'response';
            }
            fields.response.addEventListener('change', protocolView); fields.pollMode.addEventListener('change', protocolView); asynchronous.input.addEventListener('change', protocolView); protocolView();
            const save = button(translateUi("保存并使用模型"), () => action(save, async () => {
                if (!valid(form)) return;
                const response = { type: fields.response.value, mimeType: fields.mime.value };
                if (response.type !== 'binary') response.path = parsePath(output.input.value);
                const http = { path: fields.path.value, body: JSON.parse(fields.body.value), response, timeoutMs: Number(fields.timeout.value) * 1000 };
                if (asynchronous.input.checked) {
                    http.poll = { idPath: parsePath(fields.idPath.value), statusPath: parsePath(fields.statusPath.value), intervalMs: Number(fields.interval.value) * 1000 };
                    if (fields.pollMode.value === 'path') http.poll.path = pollPath.input.value; else http.poll.urlPath = parsePath(pollUrl.input.value);
                    for (const key of ['pending','succeeded','failed']) http.poll[key] = fields[key].value.trim().startsWith('[') ? JSON.parse(fields[key].value) : fields[key].value.split(',').map(value => value.trim()).filter(Boolean);
                }
                const model = { ...(current.id ? { id: current.id } : {}), name: fields.name.value.trim() || fields.remote.value.trim(), remoteModel: fields.remote.value.trim(), kind: fields.kind.value, instructions: fields.instructions.value, parameters: JSON.parse(fields.parameters.value), http };
                if (!confirm(translateUi("保存“{0}”的接入配置到“{1}”？这一步不会生成媒体。", model.name, provider.name))) return;
                const result = await api(`/providers/${encodeURIComponent(providerId)}/models`, { ...stamp(), model });
                await reload(); changed(view === epoch && dialog.open ? result.modelId : undefined); if (view === epoch) dialog.close();
            }), true);
            footer.append(save);
        }
        document.getElementById('mc-close').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { epoch++; content.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; }); content.replaceChildren(); footer.replaceChildren(); });
        document.querySelectorAll('[data-media-settings-kind]').forEach(button => button.addEventListener('click', () => window.PiMediaConnections.open({ kind: button.dataset.mediaSettingsKind })));
        window.PiMediaConnections = { open: options => { kind = labels[options?.kind] ? options.kind : 'image'; if (!dialog.open) dialog.showModal(); showOverview(); } };
    });
})();
