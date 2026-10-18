(() => {
    const node = (tag, text, attrs = {}) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
    const button = (text, id, action) => { const b = node('button', text, { type: 'button', ...(id ? { id } : {}) }); b.addEventListener('click', action); return b; };
    const select = (items, value, id) => { const s = node('select', undefined, id ? { id } : {}); for (const [v, text] of items) s.append(node('option', text, { value: v })); s.value = value; return s; };
    const label = (text, field) => { const l = node('label', text); l.append(field); return l; };
    window.PiNativeUI = { node, button, select, label };
})();
