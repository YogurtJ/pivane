'use strict';

// Pivane-owned comparison primitives. No upstream store or model call is used here.
const { scanKnowledgeContent } = require('./content-scan');
const LIMITS = Object.freeze({ scannedItems: 400, candidates: 12, promptBytes: 1800, previewChars: 240 });
const fail = message => { throw Object.assign(new Error(message), { status: 409, code: 'knowledge-comparison' }); };

// Preserve case, punctuation, inner whitespace, identifiers and numbers. Only
// canonical Unicode, outer whitespace and native trailing metadata are equivalent.
function normalizeMemory(value) {
    return typeof value === 'string' ? value.normalize('NFC').trim()
        .replace(/\s*<!--\s*created=\d{4}-\d{2}-\d{2},\s*last=\d{4}-\d{2}-\d{2}\s*-->$/u, '').trim() : '';
}
function normalizeSkill(value) {
    if (typeof value !== 'string') return '';
    const frontmatter = /^---\n[\s\S]*?\n---\n/u.exec(value)?.[0] || '';
    const description = /^description: (.*)$/mu.exec(frontmatter)?.[1] || '';
    const body = value.slice(frontmatter.length).replace(/^\s*# [^\n]+\n/u, '')
        .replace(/^##\s+(when to use|procedure|verification|pitfalls)\s*$/gimu, (_match, heading) => `## ${heading.toLowerCase()}`);
    const normalized = normalizeMemory(body);
    // Keep the trigger description when the body has no applicability section;
    // identical mechanics for different apps are not automatically one workflow.
    const applicability = /^##\s+(when to use|适用范围|使用条件)\s*$/miu.test(body);
    return normalized.length >= 80 ? (applicability ? normalized : `${normalizeMemory(description)}\n${normalized}`) : '';
}
function sameScope(left, right) {
    return left.scope === right.scope && (left.projectKey || null) === (right.projectKey || null);
}
function duplicate(rows, candidate, exclude = new Set(), contentOf = row => row.content) {
    const content = candidate.kind === 'skill' ? normalizeSkill(candidate.content) : normalizeMemory(candidate.content);
    if (!content) return null;
    const matches = rows.filter(row => !exclude.has(row.id) && !row.mirrored && row.state === 'active'
        && row.kind === candidate.kind && sameScope(row, candidate)
        && ((candidate.kind === 'skill' || candidate.scope === 'project') ? row.target === candidate.target
            : ['memory', 'user'].includes(row.target) && ['memory', 'user'].includes(candidate.target))
        && (candidate.kind === 'skill' ? normalizeSkill(contentOf(row)) : normalizeMemory(contentOf(row))) === content);
    return matches.find(row => !row.readOnly) || matches[0] || null;
}
function visible(row, projectKey) {
    return !row.mirrored && ['active', 'draft'].includes(row.state)
        && (row.scope === 'profile' || projectKey && row.scope === 'project' && row.projectKey === projectKey);
}
const STOP = new Set(['user', 'the', 'and', 'with', 'this', 'that', 'from', 'remember', 'please', '用户', '以后', '记住', '我们', '这个', '一个', '希望']);
function terms(value) {
    const text = String(value || '').normalize('NFC').toLowerCase(), result = new Set();
    for (const match of text.matchAll(/[a-z][a-z0-9_.-]+|\d{2,}|[\p{Script=Han}]{2,}/gu)) {
        const word = match[0];
        if (/^[\p{Script=Han}]+$/u.test(word)) {
            for (let i = 0; i < word.length - 1; i++) if (!STOP.has(word.slice(i, i + 2))) result.add(word.slice(i, i + 2));
        } else if (!STOP.has(word)) result.add(word);
    }
    return result;
}
function rank(rows, query) {
    const wanted = terms(query), indexed = rows.map((row, index) => ({ row, index,
        tokens: terms(`${row.name || ''} ${row.description || ''} ${row.content || ''}`) }));
    const frequency = new Map();
    for (const entry of indexed) for (const token of entry.tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
    for (const entry of indexed) entry.score = [...wanted].reduce((score, token) => score
        + (entry.tokens.has(token) ? Math.log(1 + indexed.length / frequency.get(token)) : 0), 0);
    return indexed.sort((a, b) => b.score - a.score || a.index - b.index);
}
async function readRows(service, profileId, { first, kind, limit = LIMITS.scannedItems } = {}) {
    first ||= await service.snapshot(profileId, kind ? { kind } : {});
    if (first.status !== 'ready' || !first.revision) fail('Profile knowledge unavailable for comparison');
    const rows = [...(first.items || [])];
    let page = first;
    for (let offset = 50; page.hasMore; offset += 50) {
        if (offset >= limit) fail('Knowledge comparison scan limit reached; no new entry was saved');
        page = await service.snapshot(profileId, { ...(kind ? { kind } : {}), offset });
        if (page.status !== 'ready' || page.revision !== first.revision) fail('Knowledge changed during comparison');
        rows.push(...(page.items || []));
    }
    return { first, rows };
}
async function fullItem(service, profileId, row) {
    const needed = row.kind === 'skill' && !row.content || row.kind === 'memory' && row.content?.length >= 512;
    if (needed && typeof service.getItem !== 'function') return { ...row, truncated: true, readOnly: true };
    if (needed) {
        const detail = await service.getItem(profileId, row.id);
        if (detail.status !== 'ready' || detail.item?.revision !== row.revision) fail('Knowledge changed during comparison');
        return detail.item;
    }
    return row;
}
// Related complete entries are preferred; truncated entries are explicitly
// non-editable. A bounded shortlist is evidence for the model, not semantic proof.
function prefix(value, end) {
    if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1]) && /[\uDC00-\uDFFF]/u.test(value[end] || '')) end--;
    return value.slice(0, end);
}
async function comparison(service, profileId, { first, rows, kind, projectKey, query = '', bytes = LIMITS.promptBytes } = {}) {
    const listed = rows ? { first, rows } : await readRows(service, profileId, { first, kind });
    const offered = [], references = [];
    let used = 2;
    const ranked = rank(listed.rows.filter(row => visible(row, projectKey) && (!kind || row.kind === kind)), query);
    for (const { row: listedRow, score } of ranked) {
        if (offered.length >= LIMITS.candidates) break;
        const row = await fullItem(service, profileId, listedRow);
        const body = row.kind === 'skill' && row.content
            ? row.content.replace(/^---\n[\s\S]*?\n---\n/u, '').replace(/^\s*# [^\n]+\n/u, '')
            : row.content || row.description || '';
        if (scanKnowledgeContent(body)?.kind === 'secret') continue;
        const ref = `${row.kind === 'skill' ? 's' : 'm'}${references.length + 1}`;
        let record = { id: ref, kind: row.kind, ...(row.target ? { target: row.target } : {}),
            ...(row.name ? { name: row.name } : {}), ...(row.description ? { description: prefix(row.description, 120) } : {}),
            ...(row.category ? { category: row.category } : {}), content: body, ...(row.truncated ? { truncated: true } : {}),
            editable: row.kind === 'memory' && row.scope === 'profile' && !row.readOnly && !row.truncated && row.state === 'active' };
        const cost = Buffer.byteLength(JSON.stringify(record)) + 1;
        if (row.kind === 'skill' || cost + used > bytes) {
            record = { ...record, content: prefix(body, LIMITS.previewChars), editable: false, truncated: true };
            while (Buffer.byteLength(JSON.stringify(record)) + used + 1 > bytes && record.content.length)
                record.content = prefix(record.content, record.content.length - 1);
            if (!record.content || Buffer.byteLength(JSON.stringify(record)) + used + 1 > bytes) continue;
        }
        offered.push(record); references.push({ ...row, ref, editable: record.editable, truncated: Boolean(record.truncated), score });
        used += Buffer.byteLength(JSON.stringify(record)) + 1;
    }
    const fresh = await service.snapshot(profileId, kind ? { kind } : {});
    if (fresh.status !== 'ready' || fresh.revision !== listed.first.revision) fail('Knowledge changed during comparison');
    return { revision: listed.first.revision, rows: listed.rows, offered, references };
}
function utf8Prefix(value, bytes) {
    const text = String(value || ''), data = Buffer.from(text);
    if (data.length <= bytes) return text;
    let end = Math.max(0, bytes);
    while (end && (data[end] & 0xc0) === 0x80) end--;
    return data.subarray(0, end).toString('utf8');
}
module.exports = { LIMITS, normalizeMemory, normalizeSkill, duplicate, visible, rank, readRows, fullItem, comparison, utf8Prefix };
