(() => {
    const t = globalThis.PiI18n?.t || ((text) => text);
    const node = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
    const id = prefix => prefix + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => b.toString(16).padStart(2, '0')).join('');
    function create({ apiFetch }) {
        const section = document.getElementById('settings-speech');
        const body = document.getElementById('settings-transcription-body');
        let snapshot, epoch = 0, busy = false;
        const action = (label, fn, primary = false) => { const b = node('button', label, primary ? 'settings-primary-button' : 'settings-secondary-button'); b.type = 'button'; b.addEventListener('click', fn); return b; };
        const message = (text, error = false) => { const p = node('p', text, error ? 'lab-error' : 'settings-help'); p.setAttribute('role', error ? 'alert' : 'status'); body.append(p); };
        const configured = () => window.dispatchEvent(new CustomEvent('transcription:configured'));
        const stamp = () => ({ confirmed: true, expectedRevision: snapshot.revision });
        function field(form, label, type = 'text', value = '', choices) {
            const wrap = node('label'), title = node('span', label);
            const input = node(type === 'select' ? 'select' : 'input');
            if (choices) for (const option of choices) input.append(new Option(option.label, option.value));
            if (type !== 'select') input.type = type;
            input.value = value; input.setAttribute('aria-label', label); input.maxLength = type === 'password' ? 32768 : 2000;
            wrap.append(title, input); form.append(wrap); return { input, wrap };
        }
        async function load() {
            const view = ++epoch; body.replaceChildren(); message(t("正在读取转录模型…"));
            try {
                const data = await apiFetch('/api/pi/composer/transcription/settings');
                if (view !== epoch || section.hidden) return;
                snapshot = data; render();
            } catch (error) {
                if (view !== epoch || section.hidden) return;
                body.replaceChildren(); message(error.message, true); body.append(action(t("刷新列表"), load));
            }
        }
        function render() {
            body.replaceChildren();
            const available = snapshot.availableModels || [];
            const preferred = (() => { try { return localStorage.getItem('pi.web.transcriptionModel'); } catch { return ''; } })();
            const control = node('div', '', 'transcription-default');
            const select = field(control, t("录音转录模型"), 'select', '', available.map(model => ({ value: model.id, label: model.name }))).input;
            select.id = 'settings-transcription-model';
            if (!available.length) { select.append(new Option(t("没有可用的转录模型。"), '')); select.disabled = true; }
            else select.value = available.some(model => model.id === preferred) ? preferred : available[0].id;
            select.addEventListener('change', () => { try { localStorage.setItem('pi.web.transcriptionModel', select.value); } catch {} configured(); });
            body.append(control);
            if (!available.length) message(t("添加转录模型后，点击输入框的麦克风即可录音。"));
            else message(t("选择后自动保存到当前浏览器；录音结束后，文字会加入草稿。"));
            for (const definition of snapshot.transcriptionModels || []) {
                const provider = snapshot.providers.find(item => item.id === definition.providerId);
                const row = node('article', '', 'transcription-model-row');
                const info = node('div'); info.append(node('strong', definition.name), node('small', `${provider?.name || ''} · ${definition.remoteModel}`));
                const buttons = node('div', '', 'transcription-actions');
                buttons.append(action(t("编辑"), () => edit(definition)), action(t("删除"), () => remove(definition)));
                row.append(info, buttons); body.append(row);
            }
            body.append(action(t("添加转录模型"), () => edit(), true));
        }
        function edit(existing) {
            const view = ++epoch; body.replaceChildren();
            const form = node('form', '', 'transcription-form');
            const provider = field(form, t("语音服务"), 'select', existing?.providerId || '', [{ value: '', label: t("新建语音服务") }, ...snapshot.providers.map(p => ({ value: p.id, label: p.name }))]);
            const remote = field(form, t("转录模型 ID"), 'text', existing?.remoteModel || ''); remote.input.required = true; remote.input.maxLength = 500;
            const name = field(form, t("显示名称"), 'text', existing?.name || ''); name.input.maxLength = 200; name.input.placeholder = t("可留空，使用模型 ID");
            const url = field(form, t("服务地址"), 'url'); url.input.placeholder = 'https://api.example.com/v1';
            const key = field(form, 'API Key', 'password'); key.input.autocomplete = 'new-password';
            const advanced = node('details'); advanced.append(node('summary', t("协议与认证")));
            const fields = node('div', '', 'transcription-form');
            const protocol = field(fields, t("转录协议"), 'select', existing?.protocol || snapshot.transcriptionProtocols[0].id, snapshot.transcriptionProtocols.map(item => ({ value: item.id, label: t(item.name) })));
            const auth = field(fields, t("认证方式"), 'select', 'bearer', [{ value: 'bearer', label: 'Bearer API Key' }, { value: 'header', label: t("自定义 Key Header") }, { value: 'none', label: t("无需 Key") }]);
            const header = field(fields, t("Key Header 名称"), 'text', 'api-key');
            advanced.append(fields); form.append(advanced);
            const hint = node('p', t("服务地址、模型 ID 和协议由你的语音服务提供；保存不会发送录音。"), 'settings-help');
            form.append(hint); body.append(form);
            let protocolEdited = Boolean(existing);
            protocol.input.addEventListener('change', () => { protocolEdited = true; });
            function authView() {
                const needsKey = !provider.input.value && auth.input.value !== 'none';
                key.wrap.hidden = !needsKey; key.input.required = needsKey; key.input.disabled = !needsKey;
                header.wrap.hidden = provider.input.value !== '' || auth.input.value !== 'header';
                header.input.required = !header.wrap.hidden; header.input.disabled = header.wrap.hidden;
            }
            function providerView() {
                const selected = snapshot.providers.find(p => p.id === provider.input.value);
                url.input.value = selected?.baseUrl || ''; url.input.readOnly = Boolean(selected); url.input.required = !selected;
                auth.wrap.hidden = Boolean(selected); authView();
                if (selected && !protocolEdited) {
                    const host = new URL(selected.baseUrl).hostname;
                    protocol.input.value = ['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com'].includes(host) ? 'mimo' : 'openai';
                }
                hint.textContent = selected ? t("复用此服务已保存的地址和凭据；管理语音服务可修改共享配置。") : t("服务地址、模型 ID 和协议由你的语音服务提供；保存不会发送录音。");
            }
            provider.input.addEventListener('change', providerView); auth.input.addEventListener('change', authView); providerView();
            url.input.addEventListener('change', () => {
                if (provider.input.value || protocolEdited) return;
                let host; try { host = new URL(url.input.value).hostname; } catch { return; }
                if (['api.xiaomimimo.com', 'token-plan-cn.xiaomimimo.com', 'token-plan-sgp.xiaomimimo.com', 'token-plan-ams.xiaomimimo.com'].includes(host)) {
                    protocol.input.value = 'mimo'; auth.input.value = 'header'; header.input.value = 'api-key'; authView();
                }
            });
            const save = action(t("保存转录模型"), async () => {
                if (busy || !form.reportValidity()) return;
                if (!provider.input.value && auth.input.value !== 'none' && !key.input.value.trim()) { key.input.required = true; key.input.reportValidity(); return; }
                const providerId = provider.input.value || id('speech-');
                const model = { id: existing?.id || id('model-'), providerId, name: (name.input.value.trim() || remote.input.value.trim()).slice(0, 200), remoteModel: remote.input.value.trim(), protocol: protocol.input.value };
                const input = { ...stamp(), model };
                if (!provider.input.value) {
                    input.provider = { id: providerId, name: (name.input.value.trim() || remote.input.value.trim()).slice(0, 200), baseUrl: url.input.value.trim(),
                        auth: auth.input.value === 'header' ? { mode: 'header', header: header.input.value.trim(), prefix: '' } : { mode: auth.input.value }, probePath: '/models', modelsPath: '/models', downloadOrigins: [] };
                    if (auth.input.value !== 'none') input.apiKey = key.input.value.trim();
                }
                key.input.value = ''; busy = true; save.disabled = true;
                try {
                    const data = await apiFetch('/api/pi/composer/transcription/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
                    try { localStorage.setItem('pi.web.transcriptionModel', data.modelId); } catch {}
                    configured();
                    if (view === epoch && !section.hidden) {
                        const loadingView = epoch + 1; await load();
                        if (epoch === loadingView && !section.hidden) message(t("转录模型已保存，可以直接录音。"));
                    }
                } catch (error) {
                    if (view === epoch && !section.hidden) { message(error.message + t("；请刷新列表核对保存状态后再操作。"), true); body.append(action(t("刷新列表"), load)); }
                } finally { busy = false; save.disabled = false; }
            }, true);
            form.addEventListener('submit', e => { e.preventDefault(); save.click(); });
            const buttons = node('div', '', 'transcription-actions'); buttons.append(action(t("取消"), () => { key.input.value = ''; epoch++; render(); }), save); body.append(buttons);
        }
        async function remove(model) {
            if (busy || !confirm(t("删除此转录模型？共享服务和凭据会保留。"))) return;
            const view = epoch; busy = true;
            try { await apiFetch('/api/pi/composer/transcription/models/' + encodeURIComponent(model.id), { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(stamp()) }); configured(); if (view === epoch) await load(); }
            catch (error) { if (view === epoch) message(error.message, true); }
            finally { busy = false; }
        }
        function close() {
            epoch++; section.hidden = true;
            body.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
            body.replaceChildren();
        }
        document.getElementById('settings-transcription-refresh').addEventListener('click', load);
        window.addEventListener('media-connections:section', event => {
            if (event.detail?.section === 'asr') { section.hidden = false; void load(); }
            else close();
        });
        document.getElementById('lab-connections-dialog').addEventListener('close', close);
        window.addEventListener('media-lab:configured', () => { if (!section.hidden) void load(); });
    }
    window.PiTranscriptionSettings = { create };
})();
