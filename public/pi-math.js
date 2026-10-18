(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const MAX_SOURCE = 10000, MAX_CACHE = 256, MAX_CACHE_BYTES = 2000000;
    const MAX_EMPHASIS_MASKS = 128;
    const MAX_TOTAL_SOURCE = 100000, MAX_TOTAL_OUTPUT = 4000000;
    const cache = new Map();
    let cacheBytes = 0;
    const escape = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    // Tokenize before Markdown consumes backslashes, underscores or HTML-like TeX.
    // Marked handles code spans/fences before their contents can reach this tokenizer.
    function formula(source) {
        const open = ['$$', '\\[', '\\(', '$'].find(value => source.startsWith(value));
        if (!open || (open === '$' && (/\s/.test(source[1] || '') || !source[1]))) return;
        const close = open === '\\[' ? '\\]' : open === '\\(' ? '\\)' : open;
        for (let i = open.length; i < Math.min(source.length, 20004); i++) {
            if (open === '$' && source[i] === '\n') return;
            // TeX comments and verbatim arguments may contain the delimiter.
            if (source[i] === '%') {
                const newline = source.indexOf('\n', i + 1);
                if (open === '$' || newline === -1) break;
                i = newline; continue;
            }
            if (source.startsWith('\\verb', i)) {
                const start = i + (source[i + 5] === '*' ? 6 : 5), delimiter = source[start];
                if (delimiter && !/[\sA-Za-z]/.test(delimiter)) {
                    const end = source.indexOf(delimiter, start + 1);
                    if (end !== -1 && !source.slice(start, end).includes('\n')) { i = end; continue; }
                }
            }
            if (source.startsWith(close, i)) {
                if (open === '$' && (/\s/.test(source[i - 1]) || /\d/.test(source[i + 1] || ''))) return;
                const text = source.slice(open.length, i);
                if (!text.trim()) return;
                return { raw: source.slice(0, i + close.length), text, display: open === '$$' || open === '\\[' };
            }
            if (source[i] === '\\') i++;
        }
        if (open !== '$') return { raw: source, text: source, display: open !== '\\(', pending: true };
    }
    // Follow Marked's code/escape rules when inspecting math before block or
    // emphasis parsing. A formula is opaque to Markdown, including its newlines.
    // Only inspect starts inside the native Markdown candidate. A formula or
    // code span may still read past that boundary to find its actual close.
    // text() extends the boundary when a formula crosses the current line.
    function* formulas(source, tokenizer, boundary = { end: source.length }) {
        const rawTags = [];
        for (let i = 0; i < boundary.end;) {
            if (source[i] === '`') {
                const code = tokenizer.codespan(source.slice(i));
                if (code) { i += code.raw.length; continue; }
            }
            if (source[i] === '<') {
                const tag = tokenizer.rules.inline.tag.exec(source.slice(i))?.[0];
                if (tag) {
                    const raw = /^<\/?(code|pre|kbd|samp|textarea)\b/i.exec(tag);
                    if (raw) {
                        const name = raw[1].toLowerCase();
                        if (tag.startsWith('</')) {
                            const index = rawTags.lastIndexOf(name);
                            if (index !== -1) rawTags.splice(index);
                        } else rawTags.push(name);
                    }
                    i += tag.length; continue;
                }
            }
            if (!rawTags.length && (source[i] === '$' || source.startsWith('\\(', i) || source.startsWith('\\[', i))) {
                const token = formula(source.slice(i));
                if (token) { yield { index: i, token }; i += token.raw.length; continue; }
            }
            i += source[i] === '\\' && i + 1 < source.length ? 2 : 1;
        }
    }
    function mapFormulas(source, tokenizer, replace, plain = source) {
        let output = '', cursor = 0;
        for (const { index, token } of formulas(source, tokenizer)) {
            output += plain.slice(cursor, index) + replace(token, index);
            cursor = index + token.raw.length;
        }
        return output + plain.slice(cursor);
    }
    // GFM removes the escape in \| while splitting cells. Hide the pipe until
    // native table tokenization finishes, then restore it before inline lexing.
    function tableMath(source, tokenizer, pipe) {
        return source.split('\n').map(row => mapFormulas(row, tokenizer,
            token => token.pending ? token.raw : token.raw.replaceAll('|', pipe))).join('\n');
    }
    function emphasisMath(source, masked, tokenizer) {
        const offset = masked.length - source.length;
        return masked.slice(0, offset) + mapFormulas(source, tokenizer,
            token => '[' + 'a'.repeat(token.raw.length - 2) + ']', masked.slice(offset));
    }
    function render(token) {
        const key = `${token.display}:${token.raw}`;
        if (cache.has(key)) {
            const html = cache.get(key);
            cache.delete(key); cache.set(key, html);
            return html;
        }
        let html;
        try {
            if (!window.katex || token.text.length > MAX_SOURCE) throw new Error('limit');
            const output = window.katex.renderToString(token.text, {
                displayMode: token.display, output: 'htmlAndMathml', throwOnError: true,
                trust: false,
                // Sentence punctuation is harmless here; preserve every other strict check.
                strict: (code, _message, token) => code === 'unicodeTextInMathMode' && /^[，。、；：！？]$/u.test(token?.text || '') ? 'ignore' : 'error',
                maxExpand: 200, maxSize: 20, macros: {}
            });
            if (output.length > 256000) throw new Error('output limit');
            // Only library-generated layout receives style/MathML/SVG privileges.
            html = window.DOMPurify.sanitize(output, {
                USE_PROFILES: { html: true, mathMl: true, svg: true },
                ADD_TAGS: ['semantics', 'annotation'], ADD_ATTR: ['encoding'],
                FORBID_TAGS: ['a', 'img', 'style', 'script', 'iframe', 'form', 'input', 'button', 'foreignObject'],
                FORBID_ATTR: ['href', 'xlink:href', 'src', 'id']
            });
        } catch {
            html = `<span class="pi-math-fallback" title="${translateUi("公式未能渲染，保留 LaTeX 原文")}">${escape(token.raw)}</span>`;
        }
        html = `<span class="pi-math${token.display ? ' pi-math-display' : ''}">${html}</span>`;
        // Count UTF-16 storage for both the source key and sanitized output.
        cache.set(key, html); cacheBytes += 2 * (key.length + html.length);
        while (cache.size > MAX_CACHE || cacheBytes > MAX_CACHE_BYTES) {
            const oldest = cache.keys().next().value;
            cacheBytes -= 2 * (oldest.length + cache.get(oldest).length); cache.delete(oldest);
        }
        return html;
    }
    window.PiMath = {
        create(renderer, options = {}) {
            const slots = new Map(), prefix = `pi-math-${Math.random().toString(36).slice(2)}-`;
            const slot = token => {
                if (token.pending) return `<span class="pi-math-fallback">${escape(token.raw)}</span>`;
                const id = prefix + slots.size;
                slots.set(id, token);
                return `<span data-pi-math-slot="${id}"></span>`;
            };
            const originalCode = renderer.code;
            renderer.code = function(token) {
                if (/^(math|latex)\s*$/i.test(token.lang || '')) {
                    const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(token.raw || '');
                    if (opening && new RegExp(`\\n {0,3}${opening[1][0]}{${opening[1].length},}\\s*$`).test(token.raw)) {
                        return slot({ text: token.text, raw: token.raw, display: true }) + '\n';
                    }
                }
                return originalCode.call(this, token);
            };
            const tokenizer = options.tokenizer || new window.marked.Tokenizer(), originalTable = tokenizer.table;
            const originalLheading = tokenizer.lheading;
            tokenizer.lheading = function(source) {
                const match = this.rules.block.lheading.exec(source);
                if (!match) return;
                // A standalone = or - belongs to TeX if a formula crosses the
                // heading underline. Let paragraph/block math parsing own it.
                for (const { index, token } of formulas(source, this, { end: match[1].length })) {
                    if (index + token.raw.length > match[1].length) return;
                }
                return originalLheading.call(this, source);
            };
            const originalParagraph = tokenizer.paragraph, originalText = tokenizer.text;
            tokenizer.paragraph = function(source) {
                // Use the native paragraph boundary, including its multiline
                // rules, rather than scanning the rest of the document.
                const paragraph = this.rules.block.paragraph.exec(source);
                if (!paragraph) return originalParagraph.call(this, source);
                for (const { index, token } of formulas(source, this, { end: paragraph[0].length })) {
                    const lineStart = source.lastIndexOf('\n', index - 1) + 1;
                    if (token.display && lineStart > 0 && /^ {0,3}$/.test(source.slice(lineStart, index))) {
                        return originalParagraph.call(this, source.slice(0, lineStart));
                    }
                }
                return originalParagraph.call(this, source);
            };
            tokenizer.text = function(source) {
                let length = source.indexOf('\n');
                if (length === -1) return originalText.call(this, source);
                const firstLine = length;
                const boundary = { end: length };
                for (const { index, token } of formulas(source, this, boundary)) {
                    if (index + token.raw.length > length) {
                        length = source.indexOf('\n', index + token.raw.length);
                        if (length === -1) length = source.length;
                        boundary.end = length;
                    }
                }
                if (length === firstLine) return originalText.call(this, source);
                const raw = source.slice(0, length);
                return { type: 'text', raw, text: raw, tokens: this.lexer.inline(raw) };
            };
            const emphasisMasks = new Map();
            for (const name of ['emStrong', 'del']) {
                const original = tokenizer[name];
                tokenizer[name] = function(source, masked, previous) {
                    if (/^[*_~]/.test(source)) {
                        let cached = emphasisMasks.get(masked);
                        if (!cached || !cached.source.endsWith(source)) {
                            cached = { source, masked: emphasisMath(source, masked, this) };
                            emphasisMasks.set(masked, cached);
                            if (emphasisMasks.size > MAX_EMPHASIS_MASKS) emphasisMasks.delete(emphasisMasks.keys().next().value);
                        }
                        masked = cached.masked;
                    }
                    return original.call(this, source, masked, previous);
                };
            }
            tokenizer.table = function(source) {
                const match = this.rules.block.table.exec(source);
                if (!match) return;
                const pipe = prefix + 'pipe', protectedSource = tableMath(match[0], this, pipe);
                if (protectedSource === match[0]) return originalTable.call(this, source);
                const firstInline = this.lexer.inlineQueue.length;
                const token = originalTable.call(this, protectedSource);
                // Keep native table structure and its queued inline work, with
                // the exact original TeX (including \|) restored in both views.
                if (token) {
                    token.raw = match[0].replace(/\n+$/, '');
                    for (const cell of [...token.header, ...token.rows.flat()]) cell.text = cell.text.replaceAll(pipe, '|');
                    for (const queued of this.lexer.inlineQueue.slice(firstInline)) queued.src = queued.src.replaceAll(pipe, '|');
                }
                return token;
            };
            const parser = new window.marked.Marked({ ...options, renderer, tokenizer, extensions: [
                { name: 'piMathBlock', level: 'block',
                    tokenizer(src) {
                        const indent = /^ {0,3}/.exec(src)[0];
                        const token = formula(src.slice(indent.length));
                        if (!token?.display || !/^(?:[^\S\n]*\n|[^\S\n]*$)/.test(src.slice(indent.length + token.raw.length))) return;
                        return { ...token, type: 'piMathBlock', raw: indent + token.raw };
                    }, renderer: slot },
                { name: 'piMathInline', level: 'inline', start: src => src.search(/\$|\\[([]/),
                    tokenizer(src) { const token = formula(src); if (token) return { ...token, type: 'piMathInline' }; }, renderer: slot }
            ] });
            return {
                parse: text => parser.parse(text),
                finish(html) {
                    if (!slots.size) return html;
                    const template = document.createElement('template'); template.innerHTML = html;
                    let sourceLength = 0, outputLength = 0, outputFull = false;
                    // One DOM walk; budgets follow actual TeX/output size, not formula count.
                    for (const target of template.content.querySelectorAll('span[data-pi-math-slot]')) {
                        const token = slots.get(target.getAttribute('data-pi-math-slot'));
                        if (!token) continue;
                        if (target.closest('pre, code, kbd, samp, textarea')) { target.replaceWith(document.createTextNode(token.raw)); continue; }
                        sourceLength += token.text.length;
                        if (sourceLength > MAX_TOTAL_SOURCE || outputFull) {
                            target.removeAttribute('data-pi-math-slot'); target.className = 'pi-math-fallback'; target.textContent = token.raw;
                            continue;
                        }
                        const rendered = render(token);
                        outputLength += rendered.length;
                        if (outputLength > MAX_TOTAL_OUTPUT) {
                            outputFull = true;
                            target.removeAttribute('data-pi-math-slot'); target.className = 'pi-math-fallback'; target.textContent = token.raw;
                            continue;
                        }
                        const content = document.createElement('template'); content.innerHTML = rendered; target.replaceWith(content.content);
                    }
                    return template.innerHTML;
                }
            };
        }
    };
})();
