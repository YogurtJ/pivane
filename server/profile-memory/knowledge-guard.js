'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { safeFile } = require('./management');

const hash = value => createHash('sha256').update(value).digest('hex');
const conflict = message => { throw Object.assign(new Error(message), { status: 409 }); };

// The legacy full-document editor shares the mutation lock, but has no item
// receipt. It may not remove managed entries or bypass deletion tombstones.
function assertKnowledgeDocumentWrite(root, target, next) {
    if (safeFile(path.join(root, '.pivane-knowledge.pending')))
        conflict('Knowledge publication needs repair before editing the document');
    const file = safeFile(path.join(root, '.pivane-knowledge.json'));
    if (!file) return;
    if (Buffer.byteLength(file.text) > 2 * 1024 * 1024) conflict('Invalid knowledge metadata');
    let data;
    try { data = JSON.parse(file.text); } catch { conflict('Invalid knowledge metadata'); }
    if (data?.version !== 1 || !data.records || !data.tombstones
        || typeof data.records !== 'object' || typeof data.tombstones !== 'object') conflict('Invalid knowledge metadata');
    const entries = next ? next.split('\n§\n') : [];
    const active = new Set(entries);
    for (const content of entries) if (Object.hasOwn(data.tombstones, hash(content)))
        conflict('A deleted or replaced memory requires explicit restore');
    for (const item of Object.values(data.records)) {
        if (item?.kind !== 'memory' || item.scope !== 'profile' || item.target !== target) continue;
        if (item.state === 'active' && !active.has(item.content))
            conflict('Managed memory must be edited through knowledge mutations');
        if (item.state !== 'active' && active.has(item.content))
            conflict('A deleted or replaced memory requires explicit restore');
    }
}
module.exports = { assertKnowledgeDocumentWrite };
