const fs = require('node:fs');
const { safeFile } = require('./pi-native-service');
const { readProjectRegistry, projectRevision } = require('./pi-assistant-project-registry');
const { readProjectBinding } = require('./pi-assistant-project-state');
const { readProfileBinding } = require('./pi-profile-state');
const { readRegistry } = require('./pi-profile-registry');

function readProjectRuntime(manager, cwd, agentDir, raw = process.env.PIVANE_ASSISTANT_PROJECT_CONTEXT) {
    if (!raw || !manager?.getSessionFile()) return null;
    try {
        const input = JSON.parse(raw), binding = readProjectBinding(manager);
        if (input?.version !== 1 || !binding || input.projectId !== binding.projectId
            || input.sessionId !== binding.sessionId || input.cwd !== cwd || manager.getCwd() !== cwd
            || !readProfileBinding(manager)?.profileId
            || input.sessionPath !== fs.realpathSync.native(manager.getSessionFile())) return null;
        const profileId = readProfileBinding(manager)?.profileId;
        if (!profileId) return null;
        const file = safeFile(agentDir, ['pivane-profiles', 'assistant-projects.json']);
        const profileFile = safeFile(agentDir, ['pivane-profiles', 'profiles.json']);
        if (!readRegistry(profileFile).state.profiles.some(p => p.id === profileId && p.enabled)) return null;
        const record = readProjectRegistry(file).state.projects.find(p => p.id === binding.projectId && p.cwd === cwd);
        if (!record || input.revision !== projectRevision(record) || input.instructions !== record.instructions) return null;
        return { context: input, instructions: record.instructions };
    } catch { return null; }
}

function registerAssistantProject(pi, getAgentDir) {
    let loaded = null, initialized = false;
    const load = ctx => {
        initialized = true;
        loaded = ctx.mode === 'rpc' && process.env.PI_WEB_NAVIGATION_TOKEN
            ? readProjectRuntime(ctx.sessionManager, ctx.cwd, getAgentDir()) : null;
        if (ctx.mode === 'rpc' && process.env.PI_WEB_NAVIGATION_TOKEN) ctx.ui.notify(JSON.stringify({
            pivaneAssistantProjectLoaded: loaded?.context.projectId ?? null,
            projectRevision: loaded?.context.revision ?? null, sessionId: ctx.sessionManager.getSessionId()
        }));
    };
    pi.on('session_start', (_event, ctx) => { load(ctx); });
    pi.on('before_agent_start', (event, ctx) => {
        if (!initialized) load(ctx);
        if (!loaded || ctx.mode !== 'rpc' || readProjectBinding(ctx.sessionManager)?.projectId !== loaded.context.projectId
            || ctx.sessionManager.getSessionId() !== loaded.context.sessionId || ctx.cwd !== loaded.context.cwd
            || !loaded.instructions.trim()) return;
        return { systemPrompt: `${event.systemPrompt}\n\n<assistant_project_instructions>\n${loaded.instructions}\n</assistant_project_instructions>` };
    });
}

module.exports = { readProjectRuntime, registerAssistantProject };
