const path = require('node:path');
const os = require('node:os');
const KEY = 'pivaneToolProvenance';
const text = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined;
function inputPath(value, cwd) {
    if (!text(value, 4096)) return;
    let file = value.startsWith('@') ? value.slice(1) : value;
    if (file === '~' || file.startsWith('~/')) file = os.homedir() + file.slice(1);
    return path.resolve(cwd, file);
}
function registerToolProvenance(pi) {
    const pending = new Map();
    let skills = [];
    const clear = () => { pending.clear(); skills = []; };
    pi.on('before_agent_start', event => {
        try {
            const loaded = event.systemPromptOptions?.skills;
            skills = Array.isArray(loaded) && loaded.length <= 3000
                ? loaded.map(s => ({ name: text(s.name, 256), filePath: text(s.filePath, 4096) })) : [];
        } catch { skills = []; }
    });
    pi.on('session_start', clear); pi.on('session_shutdown', clear); pi.on('agent_end', clear);
    pi.on('tool_call', (event, ctx) => {
        // Presentation metadata is best-effort and must never block or alter execution.
        try {
            if (ctx.mode !== 'rpc' || !process.env.PI_WEB_NAVIGATION_TOKEN) return;
            const toolName = text(event.toolName, 256), callId = text(event.toolCallId, 256);
            if (!toolName || !callId) return;
            const source = pi.getAllTools().find(tool => tool.name === toolName)?.sourceInfo;
            const record = { version: 1, toolName, toolCallId: callId };
            if (source && !['builtin', 'sdk'].includes(source.source) && text(source.source, 1000) && text(source.path, 4096)) {
                record.source = { source: source.source, path: source.path,
                    scope: ['user', 'project', 'temporary'].includes(source.scope) ? source.scope : undefined,
                    origin: source.origin === 'package' ? 'package' : 'top-level' };
            }
            // Only the known built-in read implementation is matched to loaded skill paths.
            if (toolName === 'read' && source?.source === 'builtin') {
                const requested = inputPath(event.input?.path, ctx.cwd);
                const skill = requested && skills.find(s => s.filePath === requested);
                if (skill && text(skill.name, 256)) record.skill = { name: skill.name, path: requested };
            }
            if (!record.source && !record.skill) return;
            if (pending.size >= 512) pending.delete(pending.keys().next().value);
            pending.set(callId, { record, cwd: ctx.cwd });
        } catch { /* Unknown metadata must not affect the tool. */ }
    });
    pi.on('tool_result', event => {
        const entry = pending.get(event.toolCallId); pending.delete(event.toolCallId);
        try {
            if (!entry || entry.record.toolName !== event.toolName) return;
            const record = entry.record;
            if (record.skill && inputPath(event.input?.path, entry.cwd) !== record.skill.path) delete record.skill;
            if (!record.source && !record.skill) return;
            // Preserve tool-specific details shapes, including primitive/array results and collisions.
            if (event.details != null && (typeof event.details !== 'object' || Array.isArray(event.details)
                || ![Object.prototype, null].includes(Object.getPrototypeOf(event.details)))) return;
            if (event.details && (Object.hasOwn(event.details, KEY) || Object.hasOwn(event.details, 'pi5ToolProvenance'))) return;
            return { details: { ...event.details, [KEY]: record } };
        } catch { /* No changes to content, errors, usage or control signals. */ }
    });
}
module.exports = { registerToolProvenance };
