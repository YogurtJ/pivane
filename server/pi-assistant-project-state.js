const PROJECT_ENTRY = 'pivane-assistant-project';
const PROJECT_CHANGE_ENTRY = 'pivane-assistant-project-change';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const projectIdValid = id => id === null || typeof id === 'string' && UUID.test(id);

// Bindings are session-wide metadata, independent of the active conversation leaf.
// Legacy duplicate bindings remain invalid. Changes form an explicit CAS chain;
// blindly accepting the last marker would let a conflicting binding take effect.
function readProjectAssignment(manager) {
    const sessionId = manager.getSessionId(), cwd = manager.getCwd();
    const invalid = { valid: false, projectId: null, revision: null };
    if (typeof sessionId !== 'string' || !sessionId) return invalid;
    const entries = manager.getEntries().filter(entry => entry.type === 'custom'
        && [PROJECT_ENTRY, PROJECT_CHANGE_ENTRY].includes(entry.customType) && entry.data?.sessionId === sessionId);
    let projectId = null, revision = null, initialized = false;
    for (const entry of entries) {
        const data = entry.data;
        if (data.version !== 1 || data.cwd !== cwd || typeof entry.id !== 'string' || !entry.id) return invalid;
        if (entry.customType === PROJECT_ENTRY) {
            if (initialized || typeof data.projectId !== 'string' || !UUID.test(data.projectId)) return invalid;
        } else if (data.previousRevision !== revision || data.previousProjectId !== projectId || !projectIdValid(data.projectId)) return invalid;
        initialized = true; projectId = data.projectId; revision = entry.id;
    }
    return { valid: true, sessionId, cwd, projectId, revision };
}

function readProjectBinding(manager) {
    const state = readProjectAssignment(manager);
    return state.valid && state.projectId ? { sessionId: state.sessionId, projectId: state.projectId, cwd: state.cwd } : null;
}

module.exports = { PROJECT_ENTRY, PROJECT_CHANGE_ENTRY, UUID, readProjectAssignment, readProjectBinding };
