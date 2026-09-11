(() => {
    const MAX_SOURCE = 10000, MAX_FORMULAS = 128, MAX_CACHE = 128;
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
            html = `<span class="pi-math-fallback" title="公式未能渲染，保留 LaTeX 原文">${escape(token.raw)}</span>`;
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
        create(renderer) {
            const slots = [], prefix = `pi-math-${Math.random().toString(36).slice(2)}-`;
            const slot = token => {
                if (token.pending) return `<span class="pi-math-fallback">${escape(token.raw)}</span>`;
                if (slots.length >= MAX_FORMULAS) return escape(token.raw);
                const id = prefix + slots.length;
                slots.push({ id, token });
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
            const parser = new window.marked.Marked({ renderer, extensions: [
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
                    if (!slots.length) return html;
                    const template = document.createElement('template'); template.innerHTML = html;
                    for (const { id, token } of slots) {
                        const target = template.content.querySelector(`span[data-pi-math-slot="${id}"]`);
                        if (target) {
                            if (target.closest('pre, code, kbd, samp, textarea')) { target.replaceWith(document.createTextNode(token.raw)); continue; }
                            const content = document.createElement('template'); content.innerHTML = render(token); target.replaceWith(content.content);
                        }
                    }
                    return template.innerHTML;
                }
            };
        }
    };
})();
