const PROFILE_ENTRY = 'pivane-agent-profile';

function readProfileBinding(manager) {
    const sessionId = manager.getSessionId();
    if (typeof sessionId !== 'string' || !sessionId) return null;
    const entries = manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === PROFILE_ENTRY
        && entry.data?.sessionId === sessionId);
    // A second or malformed session-bound marker cannot change an immutable identity.
    if (entries.length !== 1 || entries[0].data.version !== 1) return null;
    const profileId = entries[0].data.profileId;
    return profileId === null || typeof profileId === 'string' && /^[a-f0-9-]{36}$/.test(profileId)
        ? { sessionId, profileId } : null;
}

module.exports = { PROFILE_ENTRY, readProfileBinding };
