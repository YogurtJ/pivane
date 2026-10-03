(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const element = (tag, className = '', text = '') => {
        const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
    };
    const attachments = new WeakMap();
    const isMedia = field => ['image', 'video'].includes(field.type);
    const displayValue = value => typeof value === 'string' && /^data:(image\/|video\/)/.test(value) ? translateUi('[附件 · {0} · {1} KiB]', value.slice(5, value.indexOf(';')), Math.round((value.length - value.indexOf(',') - 1) * 3 / 4 / 1024)) : typeof value === 'string' && value.length > 1000 && /^[A-Za-z0-9+/]+={0,2}$/.test(value) ? translateUi('[二进制编码 · {0} 字符]', value.length) : value;
    function attachmentInput(container, label, field, value) {
        const input = element('input'); input.type = 'hidden'; input.value = value || '';
        const picker = element('input'); picker.type = 'file'; picker.accept = field.type === 'image' ? 'image/png,image/jpeg,image/webp' : 'video/mp4';
        picker.setAttribute('aria-label', field.label || field.type);
        const preview = element(field.type === 'image' ? 'img' : 'video', 'lab-attachment-preview');
        if (field.type === 'video') { preview.controls = true; preview.preload = 'metadata'; preview.playsInline = true; } else preview.alt = field.label || '参考图片';
        const note = element('small', '', translateUi('PNG / JPEG / WebP 或 MP4；附件合计最多 20 MiB。'));
        const clear = element('button', 'lab-secondary', translateUi('移除附件')); clear.type = 'button';
        let sequence = 0;
        const refresh = () => { preview.hidden = !input.value; clear.disabled = !input.value; if (input.value) preview.src = input.value; else preview.removeAttribute('src'); };
        const changed = () => input.dispatchEvent(new Event('input', { bubbles: true }));
        clear.addEventListener('click', () => { sequence++; attachments.delete(input); input.value = ''; refresh(); changed(); });
        picker.addEventListener('change', async () => {
            const file = picker.files[0]; picker.value = ''; if (!file) return;
            const selected = ++sequence; attachments.set(input, true); changed(); note.textContent = translateUi('正在读取附件…');
            try {
                const allowed = field.type === 'image' ? ['image/png', 'image/jpeg', 'image/webp'] : ['video/mp4'];
                if (!allowed.includes(file.type) || file.size > 20 * 1024 * 1024 || !file.size) throw new Error(translateUi('文件格式不支持或超过 20 MiB。'));
                const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(translateUi('读取附件失败'))); reader.readAsDataURL(file); });
                if (sequence !== selected || !container.contains(input)) return;
                input.value = data; refresh(); note.textContent = file.name;
            } catch (error) { if (sequence === selected) note.textContent = error.message; }
            finally { if (sequence === selected) { attachments.delete(input); changed(); } }
        });
        label.append(picker, preview, clear, note); refresh();
        return input;
    }
    const states = new WeakMap(), listening = new WeakSet();
    const common = {
        image: new Set(['prompt', 'size', 'width', 'height', 'ratio', 'aspect_ratio']),
        video: new Set(['prompt', 'duration', 'resolution', 'ratio', 'aspect_ratio']),
        tts: new Set(['text', 'input', 'voice', 'language', 'language_type', 'speed'])
    };
    function summary(container) {
        const state = states.get(container);
        if (!state?.summary) return;
        const values = collect(container, false);
        state.summary.replaceChildren();
        for (const [key, field] of Object.entries(state.model.parameters)) {
            const row = element('div', 'lab-parameter-row'); row.dataset.parameter = key;
            const name = element('dt', '', field.label ? translateUi(field.label) : key);
            if (field.label && field.label !== key) name.append(element('small', '', key));
            const value = values[key];
            const text = value === undefined ? (field.required ? translateUi("未指定 · 请让 Agent 补充") : translateUi("未指定 · 由服务决定"))
                : value === '' ? translateUi("空文本") : typeof value === 'boolean' ? (value ? translateUi("是（true）") : translateUi("否（false）"))
                    : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(displayValue(value));
            const output = element('dd', '', text);
            if (value === undefined) output.classList.add('lab-parameter-unset');
            row.append(name, output); state.summary.append(row);
        }
    }
    function render(container, selectedModel, values = {}, invalidJson = {}, options = {}) {
        container.replaceChildren();
        states.delete(container);
        if (options.compact) {
            const retained = {}, definitions = {};
            for (const [key, field] of Object.entries(selectedModel.parameters)) {
                if (isMedia(field) || common[selectedModel.kind]?.has(key) && field.const === undefined && field.type !== 'json') continue;
                definitions[key] = field;
                const value = Object.hasOwn(values, key) ? values[key] : field.default ?? field.const;
                if (value !== undefined) retained[key] = JSON.parse(JSON.stringify(value));
            }
            states.set(container, { model: selectedModel, retained, definitions });
        }
        for (const [key, field] of Object.entries(selectedModel.parameters)) {
            if (states.get(container)?.definitions[key]) continue;
            const label = element(isMedia(field) ? 'div' : 'label', 'lab-field' + (['textarea', 'json', 'image', 'video'].includes(field.type) ? ' wide' : '') + (field.type === 'boolean' ? ' boolean' : ''));
            label.append(element('span', '', field.label ? translateUi(field.label) : key));
            let input;
            if (isMedia(field)) {
                input = attachmentInput(container, label, field, values[key]);
            } else if (field.type === 'select') {
                input = element('select');
                for (const choice of field.choices) {
                    const value = typeof choice === 'object' ? choice.value : choice;
                    input.append(new Option(typeof choice === 'object' ? translateUi(choice.label || String(value)) : choice, value));
                }
            } else if (field.type === 'textarea' || field.type === 'json') {
                input = element('textarea'); input.rows = field.type === 'json' ? 6 : 3;
            } else {
                input = element('input'); input.type = field.type === 'boolean' ? 'checkbox' : field.type === 'number' ? 'number' : 'text';
                if (field.min !== undefined) input.min = field.min;
                if (field.max !== undefined) input.max = field.max;
                if (field.type === 'number') input.step = field.step || (field.integer ? 1 : 'any');
            }
            if (['text', 'textarea', 'json'].includes(field.type)) input.maxLength = field.maxLength || 12000;
            input.dataset.param = key; input.dataset.type = field.type;
            input.setAttribute('aria-label', field.label ? translateUi(field.label) : key);
            input.required = Boolean(field.required);
            input.dataset.omitEmpty = String(!field.required && field.default === undefined && field.const === undefined && ['text', 'textarea', 'image', 'video'].includes(field.type));
            if (field.const !== undefined) { input.readOnly = true; if (input.tagName === 'SELECT' || input.type === 'checkbox') input.disabled = true; }
            const value = Object.hasOwn(values, key) ? values[key] : field.default ?? field.const;
            if (field.type === 'boolean') input.checked = Boolean(value);
            else input.value = field.type === 'json' ? invalidJson[key] ?? JSON.stringify(value ?? {}, null, 2) : value ?? '';
            label.append(input);
            if (field.description) label.append(element('small', '', translateUi(field.description)));
            container.append(label);
        }
        if (options.compact && !options.reviewed && ['image', 'video'].includes(selectedModel.kind)) {
            const mediaFields = Object.values(selectedModel.parameters).filter(isMedia);
            const message = !mediaFields.length ? '当前模型未声明参考附件输入。请在“接入模型”中选择参考图/首帧模板，或按服务文档配置图片、视频参数。'
                : mediaFields.some(field => field.type === 'video') ? '图片会随规划请求交给辅助 Agent；参考视频仅提交生成模型，辅助 Agent 尚未读取视频内容。' : '参考图片会随规划请求交给辅助 Agent，并在确认生成后提交所选模型。';
            container.append(element('p', 'lab-parameter-note wide', translateUi(message)));
        }
        const state = states.get(container);
        if (state) {
            const panel = element('section', 'lab-parameter-summary wide');
            panel.setAttribute('aria-label', translateUi("本次生成参数"));
            panel.append(element('h3', '', translateUi("本次生成参数")), element('p', 'lab-parameter-model', selectedModel.name),
                element('p', 'lab-parameter-note', options.reviewed ? translateUi("服务端已校验；确认后按此清单提交。") : translateUi("当前参数草稿 · 提交前会由服务端校验。")));
            state.note = panel.lastElementChild;
            state.summary = element('dl', 'lab-parameter-values'); state.summary.tabIndex = 0; state.summary.setAttribute('aria-label', translateUi("参数明细，可滚动")); panel.append(state.summary);
            if (!options.reviewed) panel.append(element('p', 'lab-parameter-note', translateUi("专属参数只读。想调整时，在创作要求中说明参数和值，再生成方案。")));
            container.append(panel); summary(container);
            if (!listening.has(container)) {
                container.addEventListener('input', () => {
                    const current = states.get(container);
                    if (current) { current.note.textContent = translateUi("参数已修改 · 提交前需重新校验。"); summary(container); }
                });
                listening.add(container);
            }
        }
    }
    function collect(container, strict = true, skip = '') {
        const state = states.get(container);
        const result = state ? JSON.parse(JSON.stringify(state.retained)) : {};
        if (strict && state) for (const [key, field] of Object.entries(state.definitions)) {
            if (field.required && (result[key] === undefined || typeof result[key] === 'string' && !result[key].trim())) throw new Error(translateUi("{0}：尚未指定，请在创作要求中补充并重新生成方案。", field.label ? translateUi(field.label) : key));
        }
        for (const input of container.querySelectorAll('[data-param]')) {
            const type = input.dataset.type, key = input.dataset.param;
            if (strict && attachments.has(input)) throw new Error(translateUi('附件正在读取，请稍候。'));
            if (strict && ['image', 'video'].includes(type) && input.required && !input.value) throw new Error(translateUi('{0}：请选择附件。', input.getAttribute('aria-label')));
            if (key === skip || input.dataset.omitEmpty === 'true' && input.value === '') continue;
            if (strict && !input.reportValidity()) throw new Error(translateUi("请核对标记的参数。"));
            if (strict && input.maxLength > 0 && input.value.length > input.maxLength) throw new Error(translateUi("{0}：最多 {1} 字符，请缩短文本。", input.getAttribute('aria-label'), input.maxLength));
            if (type === 'boolean') result[key] = input.checked;
            else if (type === 'number') { if (input.value !== '') result[key] = Number(input.value); }
            else if (type === 'json') {
                try { result[key] = JSON.parse(input.value); }
                catch { if (strict) throw new Error(translateUi("{0}：JSON 格式无效。", input.getAttribute('aria-label'))); }
            } else result[key] = input.value;
        }
        return result;
    }
    window.PiMediaFields = { render, collect, displayValue, isLoading: container => [...container.querySelectorAll('[data-param]')].some(input => attachments.has(input)) };
})();
