(() => {
    const element = (tag, className = '', text = '') => {
        const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
    };
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
            const name = element('dt', '', field.label || key);
            if (field.label && field.label !== key) name.append(element('small', '', key));
            const value = values[key];
            const text = value === undefined ? (field.required ? '未指定 · 请让 Agent 补充' : '未指定 · 由服务决定')
                : value === '' ? '空文本' : typeof value === 'boolean' ? (value ? '是（true）' : '否（false）')
                    : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
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
                if (common[selectedModel.kind]?.has(key) && field.const === undefined && field.type !== 'json') continue;
                definitions[key] = field;
                const value = Object.hasOwn(values, key) ? values[key] : field.default ?? field.const;
                if (value !== undefined) retained[key] = JSON.parse(JSON.stringify(value));
            }
            states.set(container, { model: selectedModel, retained, definitions });
        }
        for (const [key, field] of Object.entries(selectedModel.parameters)) {
            if (states.get(container)?.definitions[key]) continue;
            const label = element('label', 'lab-field' + (['textarea', 'json'].includes(field.type) ? ' wide' : '') + (field.type === 'boolean' ? ' boolean' : ''));
            label.append(element('span', '', field.label || key));
            let input;
            if (field.type === 'select') {
                input = element('select');
                for (const choice of field.choices) {
                    const value = typeof choice === 'object' ? choice.value : choice;
                    input.append(new Option(typeof choice === 'object' ? choice.label || value : choice, value));
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
            input.setAttribute('aria-label', field.label || key);
            input.required = Boolean(field.required);
            input.dataset.omitEmpty = String(!field.required && field.default === undefined && field.const === undefined && ['text', 'textarea'].includes(field.type));
            if (field.const !== undefined) { input.readOnly = true; if (input.tagName === 'SELECT' || input.type === 'checkbox') input.disabled = true; }
            const value = Object.hasOwn(values, key) ? values[key] : field.default ?? field.const;
            if (field.type === 'boolean') input.checked = Boolean(value);
            else input.value = field.type === 'json' ? invalidJson[key] ?? JSON.stringify(value ?? {}, null, 2) : value ?? '';
            label.append(input);
            if (field.description) label.append(element('small', '', field.description));
            container.append(label);
        }
        const state = states.get(container);
        if (state) {
            const panel = element('section', 'lab-parameter-summary wide');
            panel.setAttribute('aria-label', '本次生成参数');
            panel.append(element('h3', '', '本次生成参数'), element('p', 'lab-parameter-model', selectedModel.name),
                element('p', 'lab-parameter-note', options.reviewed ? '服务端已校验；确认后按此清单提交。' : '当前参数草稿 · 提交前会由服务端校验。'));
            state.note = panel.lastElementChild;
            state.summary = element('dl', 'lab-parameter-values'); state.summary.tabIndex = 0; state.summary.setAttribute('aria-label', '参数明细，可滚动'); panel.append(state.summary);
            if (!options.reviewed) panel.append(element('p', 'lab-parameter-note', '专属参数只读。想调整时，在创作要求中说明参数和值，再生成方案。'));
            container.append(panel); summary(container);
            if (!listening.has(container)) {
                container.addEventListener('input', () => {
                    const current = states.get(container);
                    if (current) { current.note.textContent = '参数已修改 · 提交前需重新校验。'; summary(container); }
                });
                listening.add(container);
            }
        }
    }
    function collect(container, strict = true, skip = '') {
        const state = states.get(container);
        const result = state ? JSON.parse(JSON.stringify(state.retained)) : {};
        if (strict && state) for (const [key, field] of Object.entries(state.definitions)) {
            if (field.required && (result[key] === undefined || typeof result[key] === 'string' && !result[key].trim())) throw new Error(`${field.label || key}：尚未指定，请在创作要求中补充并重新生成方案。`);
        }
        for (const input of container.querySelectorAll('[data-param]')) {
            const type = input.dataset.type, key = input.dataset.param;
            if (key === skip || input.dataset.omitEmpty === 'true' && input.value === '') continue;
            if (strict && !input.reportValidity()) throw new Error('请核对标记的参数。');
            if (strict && input.maxLength > 0 && input.value.length > input.maxLength) throw new Error(`${input.getAttribute('aria-label')}：最多 ${input.maxLength} 字符，请缩短文本。`);
            if (type === 'boolean') result[key] = input.checked;
            else if (type === 'number') { if (input.value !== '') result[key] = Number(input.value); }
            else if (type === 'json') {
                try { result[key] = JSON.parse(input.value); }
                catch { if (strict) throw new Error(`${input.getAttribute('aria-label')}：JSON 格式无效。`); }
            } else result[key] = input.value;
        }
        return result;
    }
    window.PiMediaFields = { render, collect };
})();
