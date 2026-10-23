/* Shared native-message references. These markers carry file data, never instructions. */
(() => {
    const hex = /^[a-f0-9]{64}$/;
    const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
    const unescape = value => value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity]));
    function valid(ref) {
        return ref && hex.test(ref.id) && hex.test(ref.revision) && ['docx', 'xlsx', 'pptx', 'pdf', 'file', 'image'].includes(ref.format)
            && typeof ref.name === 'string' && ref.name.length > 0 && ref.name.length <= 240
            && !/[\x00-\x1f\x7f/\\]/.test(ref.name) && Number.isSafeInteger(ref.size) && ref.size > 0
            && ref.size <= (['file', 'image'].includes(ref.format) ? 100 : 20) * 1024 * 1024;
    }
    function marker(ref) {
        if (!valid(ref)) throw new Error('Invalid document reference');
        const tag = ['file', 'image'].includes(ref.format) ? 'pivane_attachment' : 'pivane_document';
        return `<${tag} id="${ref.id}" revision="${ref.revision}" name="${escape(ref.name)}" format="${ref.format}" bytes="${ref.size}" />`;
    }
    function split(text) {
        const result = [], pattern = /<(pivane_document|pivane_attachment) id="([a-f0-9]{64})" revision="([a-f0-9]{64})" name="([^"<>\r\n]{1,1440})" format="(docx|xlsx|pptx|pdf|file|image)" bytes="([0-9]{1,9})" \/>/g;
        let offset = 0, match;
        while ((match = pattern.exec(String(text)))) {
            const ref = { id: match[2], revision: match[3], name: unescape(match[4]), format: match[5], size: Number(match[6]) };
            if (!valid(ref) || marker(ref) !== match[0]) continue;
            if (match.index > offset) result.push({ text: text.slice(offset, match.index) });
            result.push({ reference: ref }); offset = pattern.lastIndex;
        }
        if (offset < text.length) result.push({ text: text.slice(offset) });
        return result;
    }
    function references(branch) {
        const found = new Map();
        for (const entry of branch) {
            if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
            const content = entry.message.content;
            const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(block => block.type === 'text').map(block => block.text).join('\n');
            for (const part of split(text)) if (part.reference) found.set(part.reference.id, part.reference);
            if (found.size > 500) throw new Error('Document reference budget exceeded');
        }
        return [...found.values()];
    }
    function validateCount(text) {
        const refs = split(text).filter(part => part.reference).map(part => part.reference);
        if (refs.length > 8) throw new Error('一次最多添加 8 个原件附件');
        if (refs.filter(ref => !['file', 'image'].includes(ref.format)).length > 5) throw new Error('一次最多添加 5 个文档附件');
    }
    const api = { valid, marker, split, references, validateCount };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else globalThis.PiDocumentReferences = api;
})();
