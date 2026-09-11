(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    document.addEventListener('DOMContentLoaded', () => {
        const $ = suffix => document.getElementById('pi-reply-tts-' + suffix);
        const dialog = $('dialog'), fields = $('fields'), models = $('model'), mapping = $('text-field');
        const bar = $('bar'), audio = $('audio');
        const render = window.PiMediaFields.render, collect = window.PiMediaFields.collect;
        let enabled = false, view = null, active = null, pending = null, generation = 0, uncertain = false;
        const jobs = new Map();
        const message = text => { $('error').textContent = text; $('error').hidden = !text; };
        const current = target => view === target && dialog.open;
        const model = () => view?.catalog.find(item => item.id === models.value);
        async function api(path, body, method = 'POST') {
            const token = sessionStorage.getItem('pi.web.token');
            const response = await (window.WorkspaceAccess?.fetch || fetch)('/api/pi/' + path, { method: body === undefined ? 'GET' : method,
                headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
                body: body === undefined ? undefined : JSON.stringify(body) });
            const data = await response.json().catch(() => null);
            if (!response.ok) throw new Error(data?.error || (response.status === 404 ? translateUi("回复朗读尚未启用。") : `HTTP ${response.status}`));
            if (!data) throw new Error(translateUi("未收到有效响应。"));
            return data;
        }
        function plainText(markdown) {
            const template = document.createElement('template');
            template.innerHTML = window.DOMPurify.sanitize(window.marked.parse(markdown), { FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'input', 'button'] });
            template.content.querySelectorAll('pre,img').forEach(el => el.remove());
            const blocks = new Set(['P','DIV','LI','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','TR','UL','OL','TABLE']);
            function text(el) {
                if (el.nodeType === Node.TEXT_NODE) return el.textContent;
                if (el.nodeName === 'BR') return '\n';
                const value = [...el.childNodes].map(text).join('');
                return blocks.has(el.nodeName) ? '\n' + value + '\n' : ['TD','TH'].includes(el.nodeName) ? value + ' ' : value;
            }
            return text(template.content).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        }
        function controls() {
            const selected = model(), locked = Boolean(view?.busy);
            models.disabled = locked; mapping.disabled = locked;
            fields.querySelectorAll('[data-param]').forEach(input => {
                const field = selected?.parameters[input.dataset.param];
                input.disabled = locked || field?.const !== undefined && (input.tagName === 'SELECT' || input.type === 'checkbox');
            });
            $('save').disabled = !selected || locked;
        }
        function draw(values = {}) {
            const selected = model(); fields.replaceChildren();
            if (!selected) { mapping.replaceChildren(); $('mapping').hidden = true; $('model-state').textContent = translateUi("请先选择语音模型，或接入自己的语音服务。"); controls(); return; }
            const previous = mapping.value;
            mapping.replaceChildren(...selected.textFields.map(key => new Option(selected.parameters[key].label || key, key)));
            mapping.value = selected.textFields.includes(view.textParameter) ? view.textParameter
                : selected.textFields.includes(previous) ? previous : selected.textFields.includes('text') ? 'text' : selected.textFields[0];
            view.textParameter = mapping.value; $('mapping').hidden = selected.textFields.length === 1;
            render(fields, { parameters: Object.fromEntries(Object.entries(selected.parameters).filter(([key]) => key !== mapping.value)) }, values);
            $('model-state').textContent = selected.executable ? translateUi("点击回复喇叭即使用这些参数生成并播放，音频保存到语音历史。") : translateUi("后端未配置，请先接入服务。");
            controls();
        }
        function close() { view = null; if (dialog.open) dialog.close(); }
        async function open() {
            close(); const target = { catalog: [], busy: true }; view = target;
            models.replaceChildren(); mapping.replaceChildren(); fields.replaceChildren();
            $('state').textContent = translateUi("正在读取语音配置"); $('model-state').textContent = ''; message('');
            controls(); dialog.showModal();
            try {
                const snapshot = await api('settings/reply-tts');
                if (!current(target)) return;
                target.catalog = snapshot.models; target.preferenceRevision = snapshot.revision;
                models.replaceChildren(new Option(translateUi("选择语音模型"), ''), ...target.catalog.map(item => new Option(item.name, item.id)));
                const selected = snapshot.defaults || (!snapshot.hasSavedDefaults && target.catalog.find(item => item.preferred && item.executable));
                models.value = selected?.modelId || selected?.id || ''; target.textParameter = snapshot.defaults?.textParameter;
                draw(snapshot.defaults?.parameters || {}); message(snapshot.warning || ''); $('state').textContent = '';
            } catch (error) { if (current(target)) { message(error.message); $('state').textContent = ''; } }
            finally { if (current(target)) { target.busy = false; controls(); } }
        }
        models.addEventListener('change', () => { view.textParameter = ''; mapping.replaceChildren(); draw(); });
        mapping.addEventListener('change', () => { view.textParameter = mapping.value; draw(); });
        fields.addEventListener('submit', event => event.preventDefault());
        fields.addEventListener('change', event => {
            if (event.target.dataset.param !== 'voice') return;
            for (const [key, value] of Object.entries(model()?.voiceDefaults?.[event.target.value] || {})) {
                const input = [...fields.querySelectorAll('[data-param]')].find(el => el.dataset.param === 'option_' + key);
                if (input) input.value = value;
            }
        });
        $('save').addEventListener('click', async () => {
            const target = view; if (!target || target.busy) return;
            try {
                const parameters = collect(fields, true, mapping.value); target.busy = true; controls(); message('');
                const saved = await api('settings/reply-tts', { modelId: models.value, textParameter: mapping.value, parameters, expectedRevision: target.preferenceRevision }, 'PUT');
                if (!current(target)) return;
                target.preferenceRevision = saved.revision; $('state').textContent = translateUi("默认配置已保存，下一次点击回复喇叭即使用。");
            } catch (error) { if (current(target)) message(error.message); }
            finally { if (current(target)) { target.busy = false; controls(); } }
        });
        function paintButton(button) {
            const job = jobs.get(button._speech?.key), busy = job?.state === 'pending';
            button.setAttribute('aria-busy', String(busy)); button.dataset.speechState = job?.state || 'idle';
            button.title = busy ? translateUi("语音生成中，可继续对话") : job?.state === 'ready' ? translateUi("播放或暂停已生成语音") : translateUi("朗读回复（TTS）");
            button.querySelector('i').className = busy ? 'fa-solid fa-spinner fa-spin' : 'fa-solid fa-volume-high';
        }
        function paint() {
            document.querySelectorAll('.pi-message-tts').forEach(paintButton);
            if (!active) return;
            bar.hidden = false; $('bar-state').textContent = active.message;
            $('audio').hidden = active.state !== 'ready'; $('download').hidden = active.state !== 'ready';
            $('retry').hidden = active.state !== 'error';
            if (active.state === 'ready') $('download').href = active.url;
        }
        function hidePlayer() {
            generation++; active = null; audio.pause(); audio.removeAttribute('src'); audio.load(); bar.hidden = true;
        }
        function reset() { close(); hidePlayer(); }
        async function play(job) {
            audio.pause(); active = job;
            if (audio.getAttribute('src') !== job.url) audio.src = job.url;
            job.message = translateUi("{0} · 正在播放", job.name); paint();
            try { await audio.play(); }
            catch { if (active === job) { job.message = translateUi("语音已就绪，浏览器限制了自动播放，请点播放器播放。"); paint(); } }
        }
        audio.addEventListener('play', () => {
            document.querySelectorAll('audio').forEach(other => { if (other !== audio) other.pause(); });
            if (active) { active.message = translateUi("{0} · 正在播放", active.name); paint(); }
        });
        audio.addEventListener('pause', () => { if (active?.state === 'ready' && !audio.ended) { active.message = translateUi("播放已暂停"); paint(); } });
        audio.addEventListener('ended', () => { if (active) { active.message = translateUi("朗读结束，可再次播放"); paint(); } });
        audio.addEventListener('error', () => { if (active?.state === 'ready') { active.message = translateUi("音频无法加载，请核对语音历史；不会重新生成。"); paint(); } });
        async function speak(request, retry = false) {
            const previous = jobs.get(request.key);
            if (previous?.state === 'ready' && !retry) {
                if (active === previous && !audio.paused) { audio.pause(); return; }
                await play(previous); return;
            }
            if (pending) { active = pending; paint(); return; }
            if (previous?.state === 'error' && !retry) { active = previous; paint(); return; }
            if (uncertain && !confirm(translateUi("此前的语音提交结果不确定。请先核对语音历史或服务方任务，确认仍要发起新的生成？"))) return;
            uncertain = false;
            const job = { ...request, state: 'pending', message: translateUi("正在准备语音，可继续输入下一条指令。") };
            jobs.set(request.key, job); active = job; pending = job; audio.pause();
            const startedGeneration = generation; let submitted = false;
            paint();
            try {
                const snapshot = await api('settings/reply-tts');
                if (generation !== startedGeneration) { jobs.delete(request.key); return; }
                let defaults = snapshot.defaults;
                if (!defaults && !snapshot.hasSavedDefaults) {
                    const preferred = snapshot.models.find(item => item.preferred && item.executable);
                    if (preferred) defaults = { modelId: preferred.id, textParameter: preferred.textFields.includes('text') ? 'text' : preferred.textFields[0], parameters: {} };
                }
                if (!defaults) {
                    jobs.delete(request.key); active = null; bar.hidden = true;
                    await open(); if (view) message(snapshot.warning || translateUi("请先保存默认语音模型和参数，再点击回复喇叭。")); return;
                }
                const selected = snapshot.models.find(item => item.id === defaults.modelId);
                if (!selected?.executable) throw new Error(translateUi("默认语音服务尚未配置，请到朗读设置中选择可用模型。"));
                const text = plainText(request.text), definition = selected.parameters[defaults.textParameter];
                if (!text) throw new Error(translateUi("这条回复没有可朗读的正文。"));
                if (text.length > (definition?.maxLength || 12000)) throw new Error(translateUi("正文 {0} 字符，超过当前模型 {1} 字符限额。请换用支持更长文本的默认模型，或到语音实验室编辑文本。", text.length, definition?.maxLength || 12000));
                const reviewed = await api('media/lab/review', { modelId: defaults.modelId, parameters: { ...defaults.parameters, [defaults.textParameter]: text } });
                if (generation !== startedGeneration) { jobs.delete(request.key); return; }
                if (reviewed.model.kind !== 'tts' || reviewed.model.id !== defaults.modelId || !reviewed.model.executable) throw new Error(translateUi("语音模型已变化，请检查默认配置。"));
                job.name = reviewed.model.name; job.message = translateUi("{0} · 正在生成，可继续对话。", job.name); paint();
                // The user's speaker click authorizes exactly this reply with their defaults.
                submitted = true;
                const response = await api('media/lab/execute', { ticket: reviewed.ticket, confirmed: true });
                const item = response.result?.asset || response.result?.historyItem, url = item?.url || item?.audioUrl;
                if (response.kind !== 'tts' || response.modelId !== reviewed.model.id || typeof url !== 'string' || !/^\/audio\/[^/\\?#]+$/.test(url)
                    || decodeURIComponent(url).includes('..') || /[/\\]/.test(decodeURIComponent(url.slice(7)))) throw new Error(translateUi("未收到有效音频，请核对语音历史。"));
                job.state = 'ready'; job.url = url; job.message = translateUi("语音已就绪，可播放");
                if (pending === job) pending = null;
                if (active === job && generation === startedGeneration) await play(job);
            } catch (error) {
                job.state = 'error'; job.message = error.message + (submitted ? translateUi(" 提交结果可能不确定，请先核对语音历史；不会自动重试。") : '');
                if (submitted) uncertain = true;
            } finally {
                if (pending === job) pending = null;
                while (jobs.size > 8) { const key = [...jobs.keys()].find(key => jobs.get(key) !== active); if (key === undefined) break; jobs.delete(key); }
                paint();
            }
        }
        $('bar-close').addEventListener('click', hidePlayer);
        $('bar-settings').addEventListener('click', open);
        $('retry').addEventListener('click', () => { if (active?.state === 'error') void speak(active, true); });
        $('close').addEventListener('click', close);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('close', () => { if (view && !dialog.open) close(); });
        $('connect').addEventListener('click', () => { close(); window.PiMediaConnections?.open({ kind: 'tts' }); });
        document.getElementById('settings-reply-tts').addEventListener('click', open);
        window.PiReplyTts = { open, close, reset, speak, plainText,
            bind(button, request) { button._speech = request; paintButton(button); button.addEventListener('click', () => void speak(request)); },
            get enabled() { return enabled; }, setEnabled(value) { enabled = value; } };
    });
})();
