'use strict';

const { randomUUID, createHash } = require('node:crypto');
const { lexer } = require('marked');

const hash = value => createHash('sha256').update(value).digest('hex');
// Deterministic rejections (nothing was published) carry a 4xx status and surface
// as upstream-style failed tool results; uncertain outcomes keep throwing.
const reject = (message, status = 400) => Object.assign(new Error(message), { status });

function toolResult(result) {
    const receipt = result.receipt;
    return { content: [{ type: 'text', text: receipt?.status === 'saved'
        ? `Profile knowledge saved. Receipt: ${receipt.id}. Index: ${receipt.indexStatus}. Activation: ${receipt.activation}.`
        : `Profile knowledge write is ${receipt?.status || 'uncertain'}. Check the receipt before retrying.` }],
    details: { success: receipt?.status === 'saved', receipt, indexStatus: receipt?.indexStatus,
        activation: receipt?.activation } };
}

function failureResult(error) {
    return { content: [{ type: 'text', text: `Profile knowledge write rejected: ${error.message}` }],
        details: { success: false, error: error.message, status: error.status } };
}

function nativeSource(context) {
    const manager = context?.sessionManager;
    const entryId = manager?.getBranch?.().at(-1)?.id || manager?.getEntries?.().at(-1)?.id;
    if (!entryId || !manager?.getSessionFile?.() || !manager?.getSessionId?.() || !context.cwd)
        throw reject('Verified native source is unavailable', 409);
    return { sessionPath: manager.getSessionFile(), sessionId: manager.getSessionId(), entryId, cwd: context.cwd };
}

async function listing(service, profileId, kind) {
    const first = await service.snapshot(profileId, { kind });
    if (first.status !== 'ready' || !first.capabilities?.[kind]) throw reject('Profile knowledge unavailable', 409);
    const rows = [...first.items];
    let page = first;
    for (let offset = 50; page.hasMore; offset += 50) {
        if (offset >= 200) throw reject('Profile knowledge search limit reached');
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
            throw reject(`Invalid skill ${label}`);
        return value.map(item => `- ${item.trim()}`).join('\n');
    };
    if (typeof args.when_to_use !== 'string' || !args.when_to_use.trim() || args.when_to_use.length > 500)
        throw reject('Invalid skill applicability');
    return `# ${args.name}\n\n## When to use\n${args.when_to_use.trim()}\n\n## Procedure\n${steps(args.procedure_steps, 'procedure')}\n\n## Verification\n${steps(args.verification_steps, 'verification')}\n`;
}

// Full-rewrite body for skill_manage update/edit. Raw content wins when present,
// mirroring the upstream skill tool; structured fields must then form a complete body.
function structuredBody(args) {
    if (typeof args.content === 'string' && args.content.trim()) return args.content.trim();
    const list = (value, label) => {
        if (!Array.isArray(value) || value.some(part => typeof part !== 'string' || !part.trim()))
            throw reject(`Invalid skill ${label}`);
        return value.map((part, index) => `${index + 1}. ${part.trim()}`).join('\n');
    };
    if (typeof args.when_to_use !== 'string' || !args.when_to_use.trim())
        throw reject('when_to_use is required when content is omitted');
    if (!Array.isArray(args.procedure_steps) || !args.procedure_steps.length)
        throw reject('procedure_steps is required when content is omitted');
    if (!Array.isArray(args.verification_steps) || !args.verification_steps.length)
        throw reject('verification_steps is required when content is omitted');
    const pitfalls = args.pitfalls === undefined ? '- None' : list(args.pitfalls, 'pitfalls') || '- None';
    return `## When to Use\n${args.when_to_use.trim()}\n\n## Procedure\n${list(args.procedure_steps, 'procedure_steps')}\n\n## Pitfalls\n${pitfalls}\n\n## Verification\n${list(args.verification_steps, 'verification_steps')}`;
}

// The service regenerates frontmatter from name/description; only manage skills
// whose stored frontmatter matches the recorded identity.
function bodyOf(text, name, description) {
    const header = `---\nname: ${name}\ndescription: ${description}\n---\n`;
    if (typeof text !== 'string' || !text.startsWith(header))
        throw reject('Skill frontmatter is not managed; edit it explicitly after review');
    return text.slice(header.length).trim();
}

function patchBody(body, section, replacement) {
    const heading = section.replace(/^#+\s*/, '').trim().toLowerCase();
    if (!heading || /[\r\n]/.test(heading)) throw reject('Invalid skill section');
    const tokens = lexer(body), matches = [];
    let offset = 0;
    for (const token of tokens) {
        if (token.type === 'heading' && token.depth === 2 && token.text.trim().toLowerCase() === heading)
            matches.push({ start: offset, heading: token.raw });
        offset += token.raw.length;
    }
    if (matches.length !== 1) throw reject('Skill section is missing or ambiguous');
    const start = matches[0].start + matches[0].heading.length;
    let end = body.length;
    offset = 0;
    for (const token of tokens) {
        if (offset >= start && token.type === 'heading' && token.depth <= 2) { end = offset; break; }
        offset += token.raw.length;
    }
    return `${body.slice(0, start)}${replacement.trim()}\n\n${body.slice(end)}`.trim();
}

function patchReplacement(args) {
    const section = String(args.section || '').replace(/^#+\s*/, '').trim().toLowerCase();
    const field = { 'when to use': args.when_to_use, when_to_use: args.when_to_use, procedure: args.procedure_steps,
        pitfalls: args.pitfalls, verification: args.verification_steps }[section];
    if (Array.isArray(field)) {
        if (!field.length || field.some(item => typeof item !== 'string' || !item.trim()))
            throw reject('Invalid skill patch content');
        return field.map((line, index) => `${index + 1}. ${line.trim()}`).join('\n');
    }
    const replacement = field || args.content;
    if (typeof replacement !== 'string' || !replacement.trim()) throw reject('Skill patch content is required');
    return replacement.trim();
}

// Structured skill updates re-read the uniquely located skill and keep the
// itemRevision CAS between the snapshot row and the service mutation.
async function skillUpdate(service, profileId, args, row) {
    const detail = await service.getItem(profileId, row.id);
    if (detail.status !== 'ready' || detail.item?.revision !== row.revision) throw reject('Skill changed', 409);
    const description = typeof args.description === 'string' && args.description.trim()
        ? args.description.trim() : detail.item.description || '';
    let body = bodyOf(detail.item.content, detail.item.name, detail.item.description || '');
    if (args.action === 'patch') {
        if (!args.section) throw reject('section is required for the patch action');
        body = patchBody(body, args.section, patchReplacement(args));
    } else body = structuredBody(args);
    return { name: detail.item.name, description, content: body };
}

function createKnowledgeMemoryTools(service, profileId) {
    async function mutate(name, args, signal, ensure, context) {
        const memory = ['memory_add', 'memory_replace', 'memory_remove'].includes(name);
        const skill = name === 'skill_manage' && ['create', 'update', 'edit', 'patch', 'delete'].includes(args?.action);
        if (!memory && !skill) return null;
        if (typeof service.mutateFromNative !== 'function') throw reject('Trusted knowledge writes are unavailable');
        signal?.throwIfAborted?.();
        if (!ensure()) throw reject('Profile memory binding changed', 409);
        const native = nativeSource(context);
        const kind = memory ? 'memory' : 'skill';
        const { first, rows } = await listing(service, profileId, kind);
        const project = memory ? args.target === 'project' : args.scope === 'project' || args.skill_id?.startsWith('project:');
        const scope = project ? 'project' : 'profile';
        const projectKey = project ? hash(native.cwd) : null;
        let row;
        if (memory && name !== 'memory_add') {
            if (typeof args.old_text !== 'string' || !args.old_text.trim()) throw reject('Exact old memory text is required');
            const matches = rows.filter(item => item.scope === scope && (!project || item.projectKey === projectKey)
                && item.target === args.target && item.state === 'active' && !item.readOnly && item.content === args.old_text.trim());
            if (matches.length !== 1) throw reject('Memory identity is missing or ambiguous', 409);
            row = matches[0];
        }
        if (skill && args.action !== 'create') {
            if (typeof args.skill_id !== 'string' || !/^(global|project):[a-z][a-z0-9-]{0,63}$/.test(args.skill_id))
                throw reject('Invalid skill identity');
            const skillName = args.skill_id.split(':')[1];
            const matches = rows.filter(item => item.scope === scope && (!project || item.projectKey === projectKey)
                && item.name === skillName && item.state === 'active' && !item.readOnly);
            if (matches.length !== 1) throw reject('Skill identity is missing or ambiguous', 409);
            row = matches[0];
        }
        const operation = memory ? name === 'memory_add' ? 'create' : name === 'memory_replace' ? 'update' : 'delete'
            : args.action === 'create' ? 'create' : args.action === 'delete' ? 'delete' : 'update';
        const skillFields = skill && operation === 'update' ? await skillUpdate(service, profileId, args, row) : {};
        const input = { requestId: `tool-${randomUUID()}`, expectedRevision: first.revision, operation, kind,
            ...(row ? { itemId: row.id, itemRevision: row.revision } : {}),
            scope,
            ...(project ? { projectKey } : {}),
            ...(memory && operation !== 'delete' ? { content: args.content, category: row?.category || 'fact' } : {}),
            ...(memory && operation === 'create' ? { target: args.target } : {}),
            ...(skill && operation === 'create' ? { name: args.name, description: args.description, content: skillBody(args) } : {}),
            ...(skill && operation === 'update' ? skillFields : {}) };
        signal?.throwIfAborted?.();
        if (!ensure()) throw reject('Profile memory binding changed', 409);
        return toolResult(await service.mutateFromNative(profileId, input, native));
    }
    return async function execute(name, args, signal, ensure = () => true, context) {
        try {
            return await mutate(name, args, signal, ensure, context);
        } catch (error) {
            if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) return failureResult(error);
            throw error;
        }
    };
}
module.exports = { createKnowledgeMemoryTools, skillBody };
