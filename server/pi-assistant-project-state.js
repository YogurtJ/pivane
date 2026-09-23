const PROJECT_ENTRY = 'pivane-assistant-project';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function readProjectBinding(manager) {
    const sessionId = manager.getSessionId();
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const entries = manager.getEntries().filter(entry => entry.type === 'custom'
        && entry.customType === PROJECT_ENTRY && entry.data?.sessionId === sessionId);
    if (entries.length !== 1) return null;
    const { version, projectId, cwd } = entries[0].data;
    return version === 1 && typeof projectId === 'string' && UUID.test(projectId) && cwd === manager.getCwd()
        ? { sessionId, projectId, cwd } : null;
}

module.exports = { PROJECT_ENTRY, UUID, readProjectBinding };
