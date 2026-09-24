'use strict';

const { randomUUID } = require('node:crypto');

function toolResult(result) {
    const receipt = result.receipt;
    return { content: [{ type: 'text', text: receipt?.status === 'saved'
        ? `Profile memory saved. Receipt: ${receipt.id}. Index: ${receipt.indexStatus}. Activation: ${receipt.activation}.`
        : `Profile memory write is ${receipt?.status || 'uncertain'}. Check the receipt before retrying.` }],
    details: { success: receipt?.status === 'saved', receipt, indexStatus: receipt?.indexStatus,
        activation: receipt?.activation } };
}

// Only global MEMORY/USER writes have a verified A-service mapping. Project
// writes retain their existing physical-cwd guard until A supports project CAS.
function createKnowledgeMemoryTools(service, profileId) {
    return async function execute(name, args, signal, ensure = () => true) {
        if (!['memory_add', 'memory_replace', 'memory_remove'].includes(name)
            || !['memory', 'user'].includes(args?.target)) return null;
        signal?.throwIfAborted?.();
        const first = await service.snapshot(profileId, { kind: 'memory' });
        if (first.status !== 'ready' || !first.capabilities?.memory) throw new Error('Profile knowledge unavailable');
        let row;
        if (name !== 'memory_add') {
            const expected = args.old_text;
            if (typeof expected !== 'string' || !expected.trim()) throw new Error('Exact old memory text is required');
            const matches = [];
            let page = first;
            for (let offset = 0; offset < 200; offset += 50) {
                if (offset) page = await service.snapshot(profileId, { kind: 'memory', offset });
                if (page.status !== 'ready' || page.revision !== first.revision) throw new Error('Profile knowledge changed');
                matches.push(...page.items.filter(item => item.scope === 'profile' && item.target === args.target
                    && item.state === 'active' && item.content === expected.trim()));
                if (!page.hasMore) break;
                if (offset === 150) throw new Error('Profile knowledge search limit reached');
            }
            if (matches.length !== 1) throw new Error('Memory identity is missing or ambiguous');
            row = matches[0];
        }
        signal?.throwIfAborted?.();
        const operation = name === 'memory_add' ? 'create' : name === 'memory_replace' ? 'update' : 'delete';
        const input = { requestId: `tool-${randomUUID()}`, expectedRevision: first.revision, operation, kind: 'memory',
            ...(row ? { itemId: row.id, itemRevision: row.revision } : {}),
            ...(name !== 'memory_remove' ? { content: args.content, category: row?.category || 'fact' } : {}),
            ...(name === 'memory_add' ? { target: args.target, scope: 'profile' } : {}) };
        if (!ensure()) throw new Error('Profile memory binding changed');
        return toolResult(await service.mutate(profileId, input));
    };
}
module.exports = { createKnowledgeMemoryTools };
