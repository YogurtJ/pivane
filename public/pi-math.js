(() => {
    const translateUi = globalThis.PiI18n?.t || ((text, ...values) => text.replace(/\{(\d+)\}/g, (_, index) => values[index] ?? `{${index}}`));
    const MAX_SOURCE = 10000, MAX_CACHE = 128;
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
            if (source.startsWith(close, i)) {
                if (open === '$' && (/\s/.test(source[i - 1]) || /[\d$]/.test(source[i + 1] || ''))) return;
                const text = source.slice(open.length, i);
                if (!text.trim()) return;
                return { raw: source.slice(0, i + close.length), text, display: open === '$$' || open === '\\[' };
            }
            if (source[i] === '\\') i++;
        }
        if (open.startsWith('\\')) return { raw: source, text: source, display: open === '\\[', pending: true };
    }
    // GFM splits table cells before inline math. Protect only closed formulas,
    // preserving escaped pipes and code spans according to Marked's own rules.
    function tableMath(source, tokenizer) {
        return source.split('\n').map(row => {
            let output = '';
            const rawTags = [];
            for (let i = 0; i < row.length;) {
                if (row[i] === '`') {
                    const code = tokenizer.codespan(row.slice(i));
                    if (code) { output += code.raw; i += code.raw.length; continue; }
                }
                if (row[i] === '<') {
                    const tag = tokenizer.rules.inline.tag.exec(row.slice(i))?.[0];
                    if (tag) {
                        const raw = /^<\/?(code|pre|kbd|samp|textarea)\b/i.exec(tag);
                        if (raw) {
                            const name = raw[1].toLowerCase();
                            if (tag.startsWith('</')) {
                                const index = rawTags.lastIndexOf(name);
                                if (index !== -1) rawTags.splice(index);
                            } else rawTags.push(name);
                        }
                        output += tag; i += tag.length; continue;
                    }
                }
                if (!rawTags.length && (row[i] === '$' || row.startsWith('\\(', i) || row.startsWith('\\[', i))) {
                    const token = formula(row.slice(i));
                    if (token?.pending) { output += row.slice(i); break; }
                    if (token) {
                        output += token.raw.replace(/(\\*)\|/g, (pipe, slashes) => slashes.length % 2 ? pipe : slashes + '\\|');
                        i += token.raw.length; continue;
                    }
                }
                const length = row[i] === '\\' && i + 1 < row.length ? 2 : 1;
                output += row.slice(i, i + length); i += length;
            }
            return output;
        }).join('\n');
    }
    function render(token) {
        const key = `${token.display}:${token.raw}`;
        if (cache.has(key)) return cache.get(key);
        let html;
        try {
            if (!window.katex || token.text.length > MAX_SOURCE) throw new Error('limit');
            const output = window.katex.renderToString(token.text, {
                displayMode: token.display, output: 'htmlAndMathml', throwOnError: true,
                trust: false, strict: 'error', maxExpand: 200, maxSize: 20, macros: {}
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
        cache.set(key, html); cacheBytes += key.length + html.length;
        while (cache.size > MAX_CACHE || cacheBytes > 1000000) {
            const oldest = cache.keys().next().value;
            cacheBytes -= oldest.length + cache.get(oldest).length; cache.delete(oldest);
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
            tokenizer.table = function(source) {
                const match = this.rules.block.table.exec(source);
                if (!match) return;
                const protectedSource = tableMath(match[0], this);
                if (protectedSource === match[0]) return originalTable.call(this, source);
                const token = originalTable.call(this, protectedSource);
                // Consumed bytes belong to the original source, not the added escapes.
                if (token) token.raw = match[0].replace(/\n+$/, '');
                return token;
            };
            const parser = new window.marked.Marked({ ...options, renderer, tokenizer, extensions: [
                { name: 'piMathBlock', level: 'block', start: src => src.search(/^ {0,3}(?:\$\$|\\\[)/m),
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
