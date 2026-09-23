const fs = require('node:fs');
const path = require('node:path');
const { safeFile } = require('./pi-native-service');
const { readRegistry, profileRevision } = require('./pi-profile-registry');
const { readProfileBinding } = require('./pi-profile-state');

function readProfileRuntime(manager, cwd, agentDir, sessionsRoot, raw = process.env.PIVANE_AGENT_PROFILE_CONTEXT) {
    if (!raw || !manager?.getSessionFile()) return null;
    try {
        const input = JSON.parse(raw);
        const binding = readProfileBinding(manager);
        const file = safeFile(agentDir, ['pivane-profiles', 'profiles.json']);
        const root = path.dirname(file);
        if (input?.version !== 1 || !binding?.profileId || input.profileId !== binding.profileId
            || input.sessionId !== manager.getSessionId() || input.cwd !== cwd || manager.getCwd() !== cwd
            || input.sessionPath !== undefined && input.sessionPath !== fs.realpathSync.native(manager.getSessionFile())
            || input.profileRoot !== path.join(root, 'data', binding.profileId)
            || input.sessionsRoot !== sessionsRoot) return null;
        safeFile(agentDir, ['pivane-profiles', 'data', binding.profileId, '.profile-root']);
        const record = readRegistry(file).state.profiles.find(p => p.id === binding.profileId && p.enabled);
        if (!record || JSON.stringify(input.memory) !== JSON.stringify({ enabled: record.memory.enabled, autoLearn: record.memory.autoLearn })
            || JSON.stringify(input.skills) !== JSON.stringify({ learnedEnabled: record.skills.learnedEnabled })
            || typeof record.soul !== 'string' || Buffer.byteLength(record.soul) > 32 * 1024) return null;
        return { context: input, soul: record.soul, revision: profileRevision(record) };
    } catch { return null; }
}

function registerAgentProfile(pi, getAgentDir) {
    let loaded = null, initialized = false;
    const load = (ctx) => {
        initialized = true;
        loaded = ctx.mode === 'rpc' && process.env.PI_WEB_NAVIGATION_TOKEN
            ? readProfileRuntime(ctx.sessionManager, ctx.cwd, getAgentDir(), path.join(fs.realpathSync.native(getAgentDir()), 'sessions')) : null;
        if (ctx.mode === 'rpc' && process.env.PI_WEB_NAVIGATION_TOKEN) ctx.ui.notify(JSON.stringify({
            pivaneAgentProfileLoaded: loaded?.context.profileId ?? null, profileRevision: loaded?.revision ?? null,
            sessionId: ctx.sessionManager.getSessionId()
        }));
    };
    pi.on('session_start', (_event, ctx) => { load(ctx); });
    pi.on('before_agent_start', (event, ctx) => {
        if (!initialized) load(ctx);
        if (!loaded || ctx.mode !== 'rpc' || readProfileBinding(ctx.sessionManager)?.profileId !== loaded.context.profileId
            || ctx.sessionManager.getSessionId() !== loaded.context.sessionId || ctx.cwd !== loaded.context.cwd
            || !loaded.soul.trim()) return;
        return { systemPrompt: `${event.systemPrompt}\n\n<assistant_profile_soul>\n${loaded.soul}\n</assistant_profile_soul>` };
    });
}

module.exports = { readProfileRuntime, registerAgentProfile };
