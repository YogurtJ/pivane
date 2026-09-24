'use strict';

const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { lexer } = require('marked');

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = message => { throw new Error(message); };
const scopeFor = (target, native) => target === 'project'
    ? { scope: 'project', projectKey: hash(native.cwd), target: 'project' }
    : { scope: 'profile', target };
const resultFor = result => ({
    content: [{ type: 'text', text: `Profile knowledge ${result.receipt.status}. Receipt: ${result.receipt.id}. Index: ${result.receipt.indexStatus}. Activation: ${result.receipt.activation}.` }],
    details: { success: result.receipt.status === 'saved', receipt: result.receipt,
        indexStatus: result.receipt.indexStatus, activation: result.receipt.activation },
});

function structuredBody(args) {
    if (typeof args.content === 'string' && args.content.trim()) return args.content.trim();
    const list = (value, label, required) => {
        if (!Array.isArray(value) || value.some(part => typeof part !== 'string' || !part.trim())) fail(`Invalid ${label}`);
        if (required && !value.length) fail(`${label} is required`);
        return value.map((part, index) => `${index + 1}. ${part.trim()}`).join('\n');
    };
    if (typeof args.when_to_use !== 'string' || !args.when_to_use.trim()) fail('when_to_use is required');
    return `## When to Use\n${args.when_to_use.trim()}\n\n## Procedure\n${list(args.procedure_steps, 'procedure_steps', true)}\n\n## Pitfalls\n${Array.isArray(args.pitfalls) && args.pitfalls.length ? list(args.pitfalls, 'pitfalls', false) : '- None'}\n\n## Verification\n${list(args.verification_steps, 'verification_steps', true)}`;
}
function bodyOf(text, name, description) {
    const header = `---\nname: ${name}\ndescription: ${description}\n---\n`;
    if (!text.startsWith(header)) fail('Skill frontmatter is not managed; edit it explicitly after review');
    return text.slice(header.length).trim();
}
function patchBody(body, section, replacement) {
    const heading = section.replace(/^#+\s*/, '').trim().toLowerCase();
    if (!heading || /[\r\n]/.test(heading)) fail('Invalid section');
    const tokens = lexer(body), matches = [];
    let offset = 0;
    for (const token of tokens) {
        if (token.type === 'heading' && token.depth === 2 && token.text.trim().toLowerCase() === heading)
            matches.push({ start: offset, heading: token.raw });
        offset += token.raw.length;
    }
    if (matches.length !== 1) fail('Skill section is missing or ambiguous');
    const start = matches[0].start + matches[0].heading.length;
    let end = body.length;
    offset = 0;
    for (const token of tokens) {
        if (offset >= start && token.type === 'heading' && token.depth <= 2) { end = offset; break; }
        offset += token.raw.length;
    }
    return `${body.slice(0, start)}${replacement.trim()}\n\n${body.slice(end)}`.trim();
}

// `native` must come from the verified worker, with an existing native entryId.
// The service re-reads the bound JSONL descriptor both before and within the mutation lock.
function createKnowledgeToolAdapter(service, profileId) {
    return async (tool, args, native, ensure = () => true) => {
        if (!['memory_add', 'memory_replace', 'memory_remove', 'skill_manage'].includes(tool)) return null;
        if (tool === 'skill_manage' && args.action === 'view') return null;
        if (!native?.cwd || !native?.entryId) fail('Native tool source is required');
        if (!ensure()) fail('Native worker binding changed');
        const first = await service.snapshot(profileId, { kind: tool === 'skill_manage' ? 'skill' : 'memory' });
        if (first.status !== 'ready' || !first.capabilities?.[tool === 'skill_manage' ? 'skill' : 'memory']) fail('Profile knowledge unavailable');
        const rows = [...first.items];
        for (let offset = 50; first.hasMore && offset <= 200; offset += 50) {
            const page = await service.snapshot(profileId, { kind: tool === 'skill_manage' ? 'skill' : 'memory', offset });
            if (page.status !== 'ready' || page.revision !== first.revision) fail('Knowledge changed while locating the item');
            rows.push(...page.items);
            if (!page.hasMore) break;
            if (offset === 200) fail('Knowledge lookup limit reached');
        }
        let operation, kind, item, fields = {};
        if (tool === 'skill_manage') {
            kind = 'skill';
            const action = args.action === 'edit' ? 'update' : args.action;
            if (!['create', 'update', 'patch', 'delete'].includes(action)) fail('Unsupported skill action');
            const projectKey = hash(native.cwd);
            let skillScope;
            if (action === 'create') {
                skillScope = args.scope === 'global' ? 'profile' : args.scope === 'project' ? 'project' : fail('Skill scope is required');
                if (typeof args.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(args.name)) fail('Invalid skill name');
                fields = { name: args.name, description: args.description, content: structuredBody(args) };
            } else {
                const id = args.skill_id;
                const prefix = `project:${native.cwd}:`;
                const isProject = typeof id === 'string' && id.startsWith(prefix);
                if (!isProject && (typeof id !== 'string' || !id.startsWith('global:'))) fail('Unverified skill scope');
                const name = id.slice(isProject ? prefix.length : 7);
                skillScope = isProject ? 'project' : 'profile';
                const matches = rows.filter(row => row.kind === 'skill' && !row.readOnly && row.scope === skillScope
                    && row.name === name && (!isProject || row.projectKey === projectKey));
                if (matches.length !== 1) fail('Skill is missing or ambiguous');
                item = matches[0];
                if (item.state !== 'active') fail('Skill is not active');
                if (action !== 'delete') {
                    const detail = await service.getItem(profileId, item.id);
                    if (detail.status !== 'ready' || detail.item.revision !== item.revision) fail('Skill changed');
                    const description = args.description?.trim() || item.description || '';
                    let body = action === 'patch' || !args.content && !args.when_to_use
                        ? bodyOf(detail.item.content, item.name, item.description || '') : structuredBody(args);
                    if (action === 'patch') {
                        const section = args.section || '';
                        const field = { 'When to Use': args.when_to_use, Procedure: args.procedure_steps,
                            Pitfalls: args.pitfalls, Verification: args.verification_steps }[section];
                        const replacement = Array.isArray(field) ? field.map((line, index) => `${index + 1}. ${line}`).join('\n') : field || args.content;
                        if (typeof replacement !== 'string' || !replacement.trim()) fail('Skill patch content is required');
                        body = patchBody(body, section, replacement);
                    }
                    fields = { name: item.name, description, content: body };
                }
            }
            operation = action === 'patch' ? 'update' : action;
            fields.scope = skillScope;
            if (skillScope === 'project') fields.projectKey = projectKey;
        } else {
            kind = 'memory';
            if (!['memory', 'user', 'project'].includes(args.target)) fail('Failure memory is read-only in the unified service');
            const selectedScope = scopeFor(args.target, native);
            operation = tool === 'memory_add' ? 'create' : tool === 'memory_replace' ? 'update' : 'delete';
            if (operation !== 'create') {
                if (typeof args.old_text !== 'string' || !args.old_text.trim()) fail('Exact old memory text is required');
                const matches = rows.filter(row => row.kind === 'memory' && !row.readOnly && row.state === 'active'
                    && row.scope === selectedScope.scope && row.target === selectedScope.target
                    && (selectedScope.scope !== 'project' || row.projectKey === selectedScope.projectKey)
                    && row.content === args.old_text.trim());
                if (matches.length !== 1) fail('Memory entry is missing or ambiguous');
                item = matches[0];
            }
            fields = { scope: selectedScope.scope, ...(selectedScope.projectKey ? { projectKey: selectedScope.projectKey } : {}),
                ...(operation === 'create' ? { target: selectedScope.target } : {}),
                ...(operation !== 'delete' ? { content: args.content, category: item?.category || 'fact' } : {}) };
        }
        if (item) Object.assign(fields, { itemId: item.id, itemRevision: item.revision });
        if (!ensure()) fail('Native worker binding changed');
        const result = await service.mutateFromNative(profileId, { requestId: `tool-${randomUUID()}`,
            expectedRevision: first.revision, operation, kind, ...fields }, native);
        return resultFor(result);
    };
}
module.exports = { createKnowledgeToolAdapter };
