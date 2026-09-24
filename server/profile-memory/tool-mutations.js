'use strict';

const { randomUUID, createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');

function toolResult(result) {
    const receipt = result.receipt;
    return { content: [{ type: 'text', text: receipt?.status === 'saved'
        ? `Profile knowledge saved. Receipt: ${receipt.id}. Index: ${receipt.indexStatus}. Activation: ${receipt.activation}.`
        : `Profile knowledge write is ${receipt?.status || 'uncertain'}. Check the receipt before retrying.` }],
    details: { success: receipt?.status === 'saved', receipt, indexStatus: receipt?.indexStatus,
        activation: receipt?.activation } };
}

function nativeSource(context) {
    const manager = context?.sessionManager;
    const entryId = manager?.getBranch?.().at(-1)?.id || manager?.getEntries?.().at(-1)?.id;
    if (!entryId || !manager?.getSessionFile?.() || !manager?.getSessionId?.() || !context.cwd)
        throw new Error('Verified native source is unavailable');
    return { sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId(), entryId, cwd: context.cwd };
}

async function listing(service, profileId, kind) {
    const first = await service.snapshot(profileId, { kind });
    if (first.status !== 'ready' || !first.capabilities?.[kind]) throw new Error('Profile knowledge unavailable');
    const rows = [...first.items];
    let page = first;
    for (let offset = 50; page.hasMore; offset += 50) {
        if (offset >= 200) throw new Error('Profile knowledge search limit reached');
        page = await service.snapshot(profileId, { kind, offset });
        if (page.status !== 'ready' || page.revision !== first.revision) throw new Error('Profile knowledge changed');
        rows.push(...page.items);
    }
    return { first, rows };
}

function skillBody(args) {
    const steps = (value, label) => {
        if (!Array.isArray(value) || !value.length || value.length > 20
            || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 300))
            throw new Error(`Invalid skill ${label}`);
        return value.map(item => `- ${item.trim()}`).join('\n');
    };
    if (typeof args.when_to_use !== 'string' || !args.when_to_use.trim() || args.when_to_use.length > 500)
        throw new Error('Invalid skill applicability');
    return `# ${args.name}\n\n## When to use\n${args.when_to_use.trim()}\n\n## Procedure\n${steps(args.procedure_steps, 'procedure')}\n\n## Verification\n${steps(args.verification_steps, 'verification')}\n`;
}

function createKnowledgeMemoryTools(service, profileId) {
    return async function execute(name, args, signal, ensure = () => true, context) {
        const memory = ['memory_add', 'memory_replace', 'memory_remove'].includes(name);
        const skill = name === 'skill_manage' && ['create', 'update', 'delete'].includes(args?.action);
        if (!memory && !skill) return null;
        if (typeof service.mutateFromNative !== 'function') throw new Error('Trusted knowledge writes are unavailable');
        signal?.throwIfAborted?.();
        if (!ensure()) throw new Error('Profile memory binding changed');
        const native = nativeSource(context);
        const kind = memory ? 'memory' : 'skill';
        const { first, rows } = await listing(service, profileId, kind);
        const project = memory ? args.target === 'project' : args.scope === 'project' || args.skill_id?.startsWith('project:');
        const scope = project ? 'project' : 'profile';
        const projectKey = project ? hash(native.cwd) : null;
        let row;
        if (memory && name !== 'memory_add') {
            if (typeof args.old_text !== 'string' || !args.old_text.trim()) throw new Error('Exact old memory text is required');
            const matches = rows.filter(item => item.scope === scope && (!project || item.projectKey === projectKey)
                && item.target === args.target && item.state === 'active' && !item.readOnly && item.content === args.old_text.trim());
            if (matches.length !== 1) throw new Error('Memory identity is missing or ambiguous');
            row = matches[0];
        }
        if (skill && args.action !== 'create') {
            if (typeof args.skill_id !== 'string' || !/^(global|project):[a-z][a-z0-9-]{0,63}$/.test(args.skill_id))
                throw new Error('Invalid skill identity');
            const skillName = args.skill_id.split(':')[1];
            const matches = rows.filter(item => item.scope === scope && (!project || item.projectKey === projectKey)
                && item.name === skillName && item.state === 'active' && !item.readOnly);
            if (matches.length !== 1) throw new Error('Skill identity is missing or ambiguous');
            row = matches[0];
        }
        if (skill && args.action === 'update') throw new Error('Structured skill updates require an explicit knowledge revision');
        const operation = memory ? name === 'memory_add' ? 'create' : name === 'memory_replace' ? 'update' : 'delete'
            : args.action === 'create' ? 'create' : 'delete';
        const input = { requestId: `tool-${randomUUID()}`, expectedRevision: first.revision, operation, kind,
            ...(row ? { itemId: row.id, itemRevision: row.revision } : { scope }),
            ...(project ? { projectKey } : {}),
            ...(memory && operation !== 'delete' ? { content: args.content, category: row?.category || 'fact' } : {}),
            ...(memory && operation === 'create' ? { target: args.target } : {}),
            ...(skill && operation === 'create' ? { name: args.name, description: args.description, content: skillBody(args) } : {}) };
        signal?.throwIfAborted?.();
        if (!ensure()) throw new Error('Profile memory binding changed');
        return toolResult(await service.mutateFromNative(profileId, input, native));
    };
}
module.exports = { createKnowledgeMemoryTools, skillBody };
