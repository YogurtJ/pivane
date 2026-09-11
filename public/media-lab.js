(() => {
    document.addEventListener('DOMContentLoaded', () => {
        const $ = id => document.getElementById(id);
        const apiRoot = '/api/pi/media/lab';
        const labels = { image: '图像', video: '视频', tts: '语音' };
        const icons = { image: 'fa-regular fa-image', video: 'fa-solid fa-film', tts: 'fa-solid fa-volume-high' };
        const drafts = new Map();
        let catalog = [], kind = 'image', modelId = '', revision = 0, historyRevision = 0, catalogRevision = 0;
        let history = [], review = null, reviewing = false, planning = false, hasConnections = false;
        let sourceReadId = 0, sourceLoading = false, infoRevision = 0, previewRevision = 0;
        const uncertain = new Set();
        const dialog = $('lab-review-dialog');
        const info = $('lab-info-dialog');
        const model = () => catalog.find(item => item.id === modelId);
        const element = (tag, className = '', text = '') => {
            const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
        };
        const icon = name => { const node = element('i', name); node.setAttribute('aria-hidden', 'true'); return node; };
        function button(label, name, handler, className = 'lab-secondary') {
            const node = element('button', className); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
            if (name) node.append(icon(name)); if (className !== 'icon-btn') node.append(document.createTextNode(label));
            node.addEventListener('click', handler); return node;
        }
        function errorAt(id, message = '') { $(id).textContent = message; $(id).hidden = !message; }
        async function api(path = '', options = {}, format = 'json') {
            const token = sessionStorage.getItem('pi.web.token');
            let response;
            try {
                response = await (window.WorkspaceAccess?.fetch || fetch)(apiRoot + path, { ...options, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
            } catch { throw new Error('连接中断；提交结果可能尚未返回，请先核对生成记录。'); }
            const data = format === 'text' ? await response.text() : await response.json().catch(() => null);
            if (!response.ok) throw Object.assign(new Error(data?.error || `HTTP ${response.status}`), { status: response.status, taskId: data?.taskId });
            return data;
        }
        const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
        function currentDraft() {
            if (!drafts.has(modelId)) drafts.set(modelId, { parameters: {}, instruction: '', source: {} });
            return drafts.get(modelId);
        }
        const fields = (container, selectedModel, values = {}, invalidJson = {}) => window.PiMediaFields.render(container, selectedModel, values, invalidJson, { compact: true, reviewed: container.id === 'lab-review-fields' });
        const collect = window.PiMediaFields.collect;
        function remember() {
            if (!modelId) return;
            const draft = currentDraft(); draft.parameters = collect($('lab-parameters'), false); draft.instruction = $('lab-instruction').value;
            draft.invalidJson = {};
            for (const input of $('lab-parameters').querySelectorAll('[data-type="json"]')) {
                try { JSON.parse(input.value); } catch { draft.invalidJson[input.dataset.param] = input.value; }
            }
        }
        function stopSourceRead() { sourceReadId++; sourceLoading = false; }
        function sourceView() {
            const source = currentDraft().source;
            const url = source.imageData || source.imageUrl;
            $('lab-source-image').hidden = !url;
            if (url) $('lab-source-image').src = url; else $('lab-source-image').removeAttribute('src');
            $('lab-source-clear').disabled = !url;
            $('lab-source').hidden = !model()?.sourceImage;
            $('lab-review').disabled = !model() || sourceLoading || reviewing;
        }
        function renderModel() {
            revision++; review = null; stopSourceRead(); errorAt('lab-error');
            const selectedModel = model();
            $('lab-parameters').replaceChildren();
            $('lab-review').disabled = !selectedModel;
            $('lab-plan').disabled = !selectedModel || planning;
            $('lab-export').disabled = !selectedModel;
            $('lab-model-docs').disabled = !selectedModel;
            $('lab-preset').hidden = !selectedModel?.presets?.length;
            $('lab-source').hidden = !selectedModel?.sourceImage;
            $('lab-plan-state').textContent = '';
            if (!selectedModel) {
                $('lab-model-state').textContent = '尚未接入模型';
                const empty = element('div', 'lab-empty wide');
                empty.append(icon(icons[kind]), element('strong', '', `添加你的${labels[kind]}模型`), element('span', '', '选择常用协议，填写服务地址、Key 和模型 ID。'), button('接入模型', 'fa-solid fa-plus', () => window.dispatchEvent(new Event('media-lab:connect'))));
                $('lab-parameters').append(empty);
                $('lab-instruction').value = ''; return;
            }
            const draft = currentDraft();
            fields($('lab-parameters'), selectedModel, draft.parameters, draft.invalidJson);
            $('lab-instruction').value = draft.instruction;
            $('lab-model-state').textContent = selectedModel.adapter === 'manual' ? '仅规划' : selectedModel.configured ? '已配置 · 提交前确认' : '后端未配置';
            $('lab-model-state').dataset.configured = String(selectedModel.configured);
            $('lab-preset').replaceChildren(new Option('预设', ''));
            for (const preset of selectedModel.presets || []) $('lab-preset').append(new Option(preset.name, preset.id));
            sourceView();
        }
        function changeKind(nextKind, preferredModelId) {
            remember(); kind = nextKind;
            const choices = catalog.filter(item => item.kind === kind);
            const previous = choices.find(item => item.id === (preferredModelId || modelId));
            modelId = (previous || choices.find(item => item.preferred) || choices.find(item => item.configured) || choices[0])?.id || '';
            $('lab-model').replaceChildren();
            for (const item of choices) $('lab-model').append(new Option(item.name, item.id));
            if (!choices.length) $('lab-model').append(new Option('尚未接入模型', ''));
            $('lab-model').value = modelId;
            document.querySelectorAll('[data-lab-kind]').forEach(node => {
                node.setAttribute('aria-selected', String(node.dataset.labKind === kind)); node.tabIndex = node.dataset.labKind === kind ? 0 : -1;
            });
            $('lab-preview').hidden = true; $('lab-preview').replaceChildren(); previewRevision++;
            history = []; renderHistory();
            renderModel(); loadHistory();
        }
        async function refresh(targetModelId) {
            const generation = ++catalogRevision;
            $('lab-refresh').disabled = true;
            try {
                const data = await api();
                if (generation !== catalogRevision) return;
                remember(); hasConnections = data.mediaConnections === true;
                // Older running servers still inject legacy image/video adapters into the catalog.
                catalog = (Array.isArray(data.models) ? data.models : []).filter(item => !['zimage', 'flux2', 'minimax-video'].includes(item.adapter));
                const selected = typeof targetModelId === 'string' && catalog.find(item => item.id === targetModelId);
                changeKind(selected ? selected.kind : kind, selected?.id);
            } catch (error) {
                errorAt('lab-error', error.status === 404 ? '实验室更新尚未启用，请在服务空闲时完成切换。' : error.message);
                if (error.status === 404) {
                    const previous = await fetch('/legacy-workspace/index.html', { method: 'HEAD' }).catch(() => null);
                    if (generation === catalogRevision && previous?.ok) {
                        const link = element('a', 'lab-secondary', '打开现有媒体界面'); link.href = '/legacy-workspace/index.html';
                        $('lab-error').append(document.createElement('br'), link);
                    }
                }
            }
            finally { if (generation === catalogRevision) $('lab-refresh').disabled = false; }
        }
        function mediaNode(asset, preview = false) {
            let node;
            if (asset.kind === 'image') {
                node = element('img'); node.src = asset.url; node.alt = asset.prompt || '生成图像'; node.loading = 'lazy';
            } else if (asset.kind === 'video') {
                node = element('video'); node.src = asset.url; node.preload = 'none'; node.playsInline = true; node.controls = preview;
            } else if (preview) { node = element('audio'); node.src = asset.url; node.controls = true; node.preload = 'metadata'; }
            else { node = element('div', 'lab-asset-mark'); node.append(icon(icons.tts)); }
            return node;
        }
        function safeAsset(item) {
            const prefix = item.kind === 'image' ? '/images/' : item.kind === 'video' ? '/videos/' : '/audio/';
            return typeof item.url === 'string' && item.url.startsWith(prefix) && !item.url.includes('..');
        }
        function assetButton(asset, handler) {
            const node = element('button', 'lab-asset'); node.type = 'button';
            node.append(mediaNode(asset));
            const meta = element('span', 'lab-asset-meta');
            meta.append(element('strong', '', asset.prompt || asset.text || asset.model || asset.filename));
            const date = new Date(asset.createdAt);
            meta.append(element('small', '', Number.isNaN(date.getTime()) ? asset.model || '' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
            node.append(meta); node.addEventListener('click', () => handler(asset)); return node;
        }
        function renderHistory() {
            const query = $('lab-search').value.trim().toLowerCase();
            const items = history.filter(item => JSON.stringify(item).toLowerCase().includes(query));
            $('lab-history-count').textContent = `(${items.length})`;
            const container = $('lab-history'); container.replaceChildren();
            if (!items.length) {
                const empty = element('div', 'lab-empty'); empty.append(icon(icons[kind]), element('span', '', query ? '没有匹配的记录' : `暂无${labels[kind]}记录`)); container.append(empty); return;
            }
            let shown = 0;
            const more = button('更多记录', 'fa-solid fa-chevron-down', showMore);
            function showMore() {
                more.remove();
                for (const item of items.slice(shown, shown + 60)) container.append(assetButton(item, previewAsset));
                shown += 60; if (shown < items.length) container.append(more);
            }
            showMore();
        }
        async function loadHistory() {
            const generation = ++historyRevision, currentKind = kind;
            try {
                const items = await api('/history?kind=' + currentKind);
                if (generation !== historyRevision || kind !== currentKind) return;
                history = (Array.isArray(items) ? items : []).filter(safeAsset); renderHistory();
            } catch (error) {
                if (generation !== historyRevision) return;
                $('lab-history').replaceChildren(element('div', 'lab-empty', error.message));
            }
        }
        function reuse(asset) {
            const match = catalog.find(item => item.id === asset.labModelId) || catalog.find(item => item.kind === asset.kind && (item.id === asset.model || item.id === `tts:${asset.provider}:${asset.model}`))
                || catalog.find(item => item.kind === 'image' && asset.model?.startsWith(item.id));
            if (!match) { errorAt('lab-error', '该历史模型未接入；原文件仍可查看和下载。'); return; }
            changeKind(match.kind, match.id);
            const parameters = { ...(asset.parameters || asset), cfg: asset.parameters?.cfg ?? asset.cfg ?? asset.cfgScale };
            if (!asset.parameters) Object.assign(parameters, {
                loraEnabled: Boolean(asset.loras?.length), loraName: asset.loras?.[0]?.name || 'none', loraStrength: asset.loras?.[0]?.strength ?? 0
            });
            for (const [key, value] of Object.entries(asset.options || {})) parameters['option_' + key] = value;
            currentDraft().invalidJson = {};
            currentDraft().parameters = Object.fromEntries(Object.entries(parameters).filter(([key, value]) => Object.hasOwn(match.parameters, key) && value !== undefined));
            renderModel(); $('lab-workspace').scrollTo({ top: 0 }); $('lab-parameters').querySelector('textarea')?.focus();
        }
        function previewAsset(asset) {
            previewRevision++;
            const container = $('lab-preview'); container.replaceChildren(); container.hidden = false;
            const media = element('div', 'lab-preview-media'); media.append(mediaNode(asset, true)); container.append(media);
            const actions = element('div', 'lab-preview-actions');
            actions.append(button('复用参数', 'fa-solid fa-sliders', () => reuse(asset)));
            const download = element('a', 'lab-secondary', '下载'); download.href = asset.url; download.download = asset.filename || ''; actions.append(download);
            const original = element('a', 'icon-btn'); original.href = asset.url; original.target = '_blank'; original.rel = 'noopener'; original.title = '新标签查看原文件'; original.setAttribute('aria-label', original.title); original.append(icon('fa-solid fa-arrow-up-right-from-square')); actions.append(original);
            if (asset.kind === 'image') actions.append(button('用作首帧', 'fa-solid fa-film', () => {
                changeKind('video');
                if (!model()?.sourceImage) { errorAt('lab-error', '当前没有支持首帧的模型。'); return; }
                currentDraft().source = { imageUrl: asset.url }; revision++; sourceView(); $('lab-workspace').scrollTo({ top: 0 });
            }));
            actions.append(button('删除这条记录及文件', 'fa-solid fa-trash', async () => {
                if (!confirm('删除这条生成记录及本地文件？此操作不能撤销。')) return;
                try { await api(`/history/${asset.kind}/${encodeURIComponent(asset.id)}`, { method: 'DELETE' }); container.hidden = true; loadHistory(); }
                catch (error) { errorAt('lab-error', error.message); }
            }, 'icon-btn'));
            actions.append(button('关闭预览', 'fa-solid fa-xmark', () => { previewRevision++; container.hidden = true; container.replaceChildren(); }, 'icon-btn'));
            container.append(actions, element('p', '', asset.prompt || asset.text || ''), element('p', '', [asset.model, asset.width && `${asset.width} × ${asset.height}`, asset.extraInfo?.rtf && `RTF ${asset.extraInfo.rtf}`].filter(Boolean).join(' · ')));
            container.scrollIntoView({ block: 'nearest' });
        }
        async function requestPlan() {
            if (planning || !model() || !$('lab-instruction').value.trim()) { $('lab-instruction').focus(); return; }
            const requestRevision = revision;
            planning = true; $('lab-plan').disabled = true; errorAt('lab-error'); $('lab-plan-state').textContent = 'Agent 正在规划';
            try {
                const result = await post('/plan', { kind, selectedModelId: modelId, instruction: $('lab-instruction').value,
                    parameters: collect($('lab-parameters'), false), cwd: localStorage.getItem('pi.web.cwd') || undefined });
                if (revision !== requestRevision) { $('lab-plan-state').textContent = '参数已变化，未覆盖当前草稿'; return; }
                if (result.plan.modelId !== modelId) throw new Error('方案模型与所选模型不一致。');
                fields($('lab-parameters'), model(), result.plan.parameters); remember(); revision++;
                $('lab-plan-state').textContent = `${result.plan.summary} · ${result.plannerModel.name}${result.fallbackUsed ? '（备用模型）' : ''}`;
            } catch (error) { if (revision === requestRevision) { errorAt('lab-error', error.message); $('lab-plan-state').textContent = '规划失败'; } }
            finally { planning = false; $('lab-plan').disabled = !model(); }
        }
        function updateReview(data) {
            review = data;
            $('lab-review-model').textContent = data.model.name;
            fields($('lab-review-fields'), data.model, data.parameters);
            $('lab-review-warnings').replaceChildren(...data.warnings.map(warning => element('div', '', warning)));
            $('lab-review-json').textContent = JSON.stringify({ modelId: data.model.id, parameters: data.parameters, source: data.source, request: data.request, execution: data.execution }, null, 2);
            $('lab-review-cost').textContent = data.cost;
            $('lab-review-state').textContent = data.model.executable ? '已校验 · 1 项' : '仅规划 · 无可用执行后端';
            $('lab-confirm').disabled = !data.model.executable;
            $('lab-review-recheck').disabled = true;
            $('lab-review-source').replaceChildren();
            if (data.source) {
                const image = element('img'); image.alt = '本次请求首帧'; image.src = currentDraft().source.imageData || currentDraft().source.imageUrl; $('lab-review-source').append(image);
            }
            errorAt('lab-review-error');
        }
        async function requestReview(recheck = false) {
            if (reviewing || sourceLoading || !model()) return;
            if (!recheck && uncertain.size) {
                if (!confirm('上一次提交结果尚未核对。请先查看历史或服务方任务。确定要创建新的提交清单？')) return;
                uncertain.clear();
            }
            const currentRevision = revision;
            reviewing = true; $('lab-review').disabled = true; $('lab-review-recheck').disabled = true; $('lab-confirm').disabled = true;
            try {
                const parameters = collect($(recheck ? 'lab-review-fields' : 'lab-parameters'));
                const result = await post('/review', { modelId, parameters, source: currentDraft().source });
                if (currentRevision !== revision || recheck && !dialog.open) return;
                updateReview(result);
                if (!dialog.open) dialog.showModal();
            } catch (error) { errorAt(recheck ? 'lab-review-error' : 'lab-error', error.message); if (recheck) $('lab-review-recheck').disabled = false; }
            finally { reviewing = false; $('lab-review').disabled = !model() || sourceLoading; }
        }
        async function execute() {
            if (!review || $('lab-confirm').disabled) return;
            const ticket = review.ticket, submittedKind = kind, submittedName = review.model.name, selectedRevision = previewRevision, managed = review.model.managed;
            $('lab-confirm').disabled = true;
            currentDraft().parameters = review.parameters; currentDraft().invalidJson = {}; fields($('lab-parameters'), model(), review.parameters); revision++;
            dialog.close(); review = null;
            const status = element('p', '', `${submittedName} · 正在生成`);
            $('lab-running').hidden = false; $('lab-running').append(status);
            let finished = false;
            const stages = { submitting: '正在提交', polling: '正在查询任务', downloading: '正在下载结果' };
            const progressTimer = managed ? setInterval(async () => {
                try {
                    const data = await api('/execution/' + encodeURIComponent(ticket));
                    if (!finished && data.status === 'running' && data.progress) status.textContent = `${submittedName} · ${stages[data.progress.stage] || '正在生成'}${data.progress.taskId ? ' · ' + data.progress.taskId : ''}`;
                } catch {}
            }, 2000) : null;
            try {
                const response = await post('/execute', { ticket, confirmed: true });
                uncertain.delete(ticket); status.textContent = `${submittedName} · 已完成`;
                if (kind === submittedKind) await loadHistory();
                if (kind === submittedKind && previewRevision === selectedRevision) {
                    const item = response.result?.asset || response.result?.image || response.result?.video || response.result?.historyItem;
                    const asset = item && { ...item, kind: submittedKind, url: item.url || item.imageUrl || item.videoUrl || item.audioUrl };
                    if (asset && safeAsset(asset)) previewAsset(asset);
                }
            } catch (error) {
                uncertain.add(ticket); status.className = 'lab-error'; status.textContent = `${submittedName} · ${error.message}${error.taskId ? ' · 任务 ' + error.taskId : ''}`;
            } finally {
                finished = true; if (progressTimer) clearInterval(progressTimer);
                status.dataset.finished = 'true';
                const completedRows = $('lab-running').querySelectorAll('[data-finished]');
                for (const old of [...completedRows].slice(0, -10)) old.remove();
            }
        }
        function exportParameters() {
            try {
                const payload = { version: 1, modelId, parameters: collect($('lab-parameters')), execution: { mode: 'manual', count: 1 } };
                const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
                const anchor = element('a'); anchor.href = url; anchor.download = 'media-request.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
            } catch (error) { errorAt('lab-error', error.message); }
        }
        $('lab-parameters').addEventListener('submit', event => event.preventDefault());
        $('lab-review-fields').addEventListener('submit', event => event.preventDefault());
        $('lab-parameters').addEventListener('input', () => { revision++; review = null; $('lab-confirm').disabled = true; remember(); });
        $('lab-parameters').addEventListener('change', event => {
            if (event.target.dataset.param !== 'voice') return;
            const defaults = model()?.voiceDefaults?.[event.target.value] || {};
            const values = collect($('lab-parameters'), false);
            for (const [key, value] of Object.entries(defaults)) values['option_' + key] = value;
            fields($('lab-parameters'), model(), values, currentDraft().invalidJson); remember(); revision++;
            $('lab-parameters').querySelector('[data-param="voice"]')?.focus();
        });
        $('lab-review-fields').addEventListener('input', () => {
            review = null; revision++; $('lab-confirm').disabled = true; $('lab-review-recheck').disabled = false; $('lab-review-state').textContent = '参数已修改 · 等待重新校验';
            $('lab-review-json').textContent = JSON.stringify({ modelId, parameters: collect($('lab-review-fields'), false) }, null, 2);
        });
        $('lab-instruction').addEventListener('input', () => { revision++; review = null; $('lab-confirm').disabled = true; remember(); $('lab-plan-state').textContent = '要求已修改，点击生成方案后才会应用到参数。'; });
        $('lab-model').addEventListener('change', () => { remember(); modelId = $('lab-model').value; renderModel(); });
        $('lab-preset').addEventListener('change', () => {
            const preset = model()?.presets?.find(item => item.id === $('lab-preset').value);
            if (preset) { currentDraft().parameters = { ...collect($('lab-parameters'), false), ...preset.parameters }; renderModel(); }
        });
        $('lab-source-file').addEventListener('change', async event => {
            const file = event.target.files[0]; event.target.value = ''; if (!file) return;
            const selectedId = modelId, readId = ++sourceReadId;
            revision++; sourceLoading = true; sourceView();
            try {
                if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 20 * 1024 * 1024) throw new Error('首帧须为 20MB 以内的 PNG、JPEG 或 WebP。');
                const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error('读取首帧失败')); reader.readAsDataURL(file); });
                if (modelId !== selectedId || readId !== sourceReadId) return;
                currentDraft().source = { imageData: data }; revision++; sourceView();
            } catch (error) { if (modelId === selectedId && readId === sourceReadId) errorAt('lab-error', error.message); }
            finally { if (readId === sourceReadId) { sourceLoading = false; sourceView(); } }
        });
        $('lab-source-clear').addEventListener('click', () => { stopSourceRead(); currentDraft().source = {}; revision++; sourceView(); });
        $('lab-source-gallery').addEventListener('click', async () => {
            stopSourceRead(); revision++; sourceView();
            const selectedId = modelId, generation = ++infoRevision; $('lab-info-title').textContent = '选择首帧'; $('lab-info-content').textContent = '正在读取'; info.showModal();
            try {
                const items = await api('/history?kind=image');
                if (!info.open || selectedId !== modelId || generation !== infoRevision) return;
                const grid = element('div', 'lab-history');
                for (const item of items.filter(safeAsset)) grid.append(assetButton(item, asset => { currentDraft().source = { imageUrl: asset.url }; revision++; sourceView(); info.close(); }));
                if (!grid.childElementCount) grid.append(element('p', 'lab-muted', '暂无图片记录'));
                $('lab-info-content').replaceChildren(grid);
            } catch (error) { if (info.open && generation === infoRevision) $('lab-info-content').textContent = error.message; }
        });
        $('lab-model-docs').addEventListener('click', () => {
            const selectedModel = model(); if (!selectedModel) return;
            infoRevision++;
            $('lab-info-title').textContent = selectedModel.name;
            $('lab-info-content').replaceChildren(element('div', 'lab-doc-text', selectedModel.instructions || ''), element('pre', '', JSON.stringify(selectedModel.parameters, null, 2)));
            if (selectedModel.documentationUrl && /^(https:\/\/|\/api\/tts\/)/.test(selectedModel.documentationUrl)) {
                const link = element('a', 'lab-secondary', '模型文档'); link.href = selectedModel.documentationUrl; link.target = '_blank'; link.rel = 'noopener'; $('lab-info-content').append(link);
            }
            info.showModal();
        });
        $('lab-connect').addEventListener('click', () => window.dispatchEvent(new Event('media-lab:connect')));
        $('lab-info-close').addEventListener('click', () => info.close());
        info.addEventListener('close', () => { infoRevision++; });
        $('lab-review-close').addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => { review = null; revision++; });
        $('lab-review-recheck').addEventListener('click', () => requestReview(true));
        $('lab-review').addEventListener('click', () => requestReview());
        $('lab-confirm').addEventListener('click', execute);
        $('lab-export').addEventListener('click', exportParameters);
        $('lab-plan').addEventListener('click', requestPlan);
        $('lab-refresh').addEventListener('click', refresh);
        $('lab-search').addEventListener('input', renderHistory);
        document.querySelectorAll('[data-lab-kind]').forEach(node => {
            node.addEventListener('click', () => changeKind(node.dataset.labKind));
            node.addEventListener('keydown', event => {
                const keys = ['ArrowRight', 'ArrowLeft', 'Home', 'End']; if (!keys.includes(event.key)) return;
                event.preventDefault(); const kinds = ['image','video','tts']; const index = kinds.indexOf(kind);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
                changeKind(kinds[next]); document.querySelector(`[data-lab-kind="${kind}"]`).focus();
            });
        });
        let loaded = false;
        window.addEventListener('workspace:tabchanged', event => {
            if (event.detail.tab === 'media' && !loaded) { loaded = true; refresh(); }
        });
        window.addEventListener('workspace:access-ready', () => { if (loaded && !catalog.length) refresh(); });
        window.addEventListener('media-lab:configured', event => refresh(event.detail?.modelId));
        window.addEventListener('media-lab:connect', () => {
            if (hasConnections && window.PiMediaConnections) { window.PiMediaConnections.open({ kind }); return; }
            const generation = ++infoRevision;
            $('lab-info-title').textContent = '接入模型';
            const template = { id: 'my-image-model', name: 'My image model', kind: 'image', adapter: 'manual',
                instructions: 'Describe model-specific constraints and parameter requirements here.',
                parameters: { prompt: { type: 'textarea', label: 'Prompt', required: true, maxLength: 3000 },
                    settings: { type: 'json', label: 'Model settings', default: { quality: 'standard' } } } };
            const editor = element('textarea', 'lab-connect-editor'); editor.setAttribute('aria-label', '模型接入定义 JSON'); editor.value = JSON.stringify(template, null, 2);
            const mode = element('select'); mode.setAttribute('aria-label', '接入模板'); mode.append(new Option('仅规划与导出', 'manual'), new Option('HTTP JSON 服务', 'http-json'));
            mode.addEventListener('change', () => {
                const next = { ...template, adapter: mode.value };
                if (mode.value === 'http-json') next.connection = { url: 'https://example.invalid/generate', tokenEnv: 'MY_MEDIA_API_KEY', parameterKey: 'input', fixedBody: { model: 'remote-model-id' }, outputPath: ['data', 0, 'b64_json'], mimeType: 'image/png' };
                editor.value = JSON.stringify(next, null, 2);
            });
            const message = element('p', 'lab-error'); message.hidden = true;
            const actions = element('div', 'lab-install-actions');
            const save = button('保存模型', 'fa-solid fa-plus', async () => {
                try {
                    const definition = JSON.parse(editor.value);
                    if (!confirm('将模型要求保存到此实例的本地配置？HTTP 适配器会向所配置的服务发送参数，只应接入可信服务。')) return;
                    save.disabled = true;
                    await post('/models', { model: definition, confirmed: true });
                    if (generation === infoRevision) info.close();
                    window.dispatchEvent(new Event('media-lab:configured'));
                } catch (error) { message.textContent = error.message; message.hidden = false; }
                finally { save.disabled = false; }
            }, 'lab-primary');
            actions.append(save);
            const docs = element('details'), documentation = element('pre', '', '正在读取');
            docs.append(element('summary', '', '接入协议'), documentation);
            let docsLoaded = false;
            docs.addEventListener('toggle', async () => {
                if (!docs.open || docsLoaded) return;
                try { documentation.textContent = await api('/docs', {}, 'text'); docsLoaded = true; }
                catch (error) { documentation.textContent = error.message; }
            });
            $('lab-info-content').replaceChildren(mode, docs, editor, message, actions); info.showModal();
        });
    });
})();
