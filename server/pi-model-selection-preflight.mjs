import { createAgentSessionFromServices } from '@earendil-works/pi-coding-agent';

function savedSelection(sessionManager, settingsManager, modelRuntime) {
    const context = sessionManager.buildSessionContext();
    const change = sessionManager.getBranch().findLast(entry => entry.type === 'model_change');
    // A registered virtual selection remains the user's choice even though its
    // responses name the physical model. Otherwise preserve native branch context.
    if (change && modelRuntime.getModel(change.provider, change.modelId)?.api === 'pi-virtual') {
        return { provider: change.provider, modelId: change.modelId };
    }
    if (context.model) return context.model;
    const provider = settingsManager.getDefaultProvider(), modelId = settingsManager.getDefaultModel();
    return provider && modelId ? { provider, modelId } : undefined;
}

// options.model must represent an explicit choice from this user/CLI invocation.
// A scoped catalog's first entry is an automatic choice, handled only when there
// is no saved/default selection. Keep the real runtime and catalog untouched.
export async function createAgentSessionWithSelectionPreflight(options) {
    if (options.model) return createAgentSessionFromServices(options);
    const { sessionManager, services } = options;
    const { modelRuntime, settingsManager } = services;
    const saved = savedSelection(sessionManager, settingsManager, modelRuntime);
    const unavailable = saved && (!modelRuntime.getModel(saved.provider, saved.modelId) || !modelRuntime.hasConfiguredAuth(saved.provider));
    if (!unavailable) {
        const scoped = !saved && !sessionManager.buildSessionContext().messages.length ? options.scopedModels?.[0] : undefined;
        return createAgentSessionFromServices({ ...options, ...(scoped ? { model: scoped.model, thinkingLevel: options.thinkingLevel ?? scoped.thinkingLevel } : {}) });
    }
    let constructing = true;
    // Only SDK bootstrap lookups are hidden. AgentSession keeps this transparent
    // facade; after construction every call delegates to the original instance,
    // including auth, refresh, extension/virtual registration and explicit setModel.
    const facade = new Proxy(modelRuntime, { get(target, key) {
        if (constructing && key === 'getModel') return () => undefined;
        if (constructing && key === 'getAvailableSnapshot') return () => [];
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    try {
        const created = await createAgentSessionFromServices({ ...options, services: { ...services, modelRuntime: facade } });
        return { ...created, modelFallbackMessage: `Saved model ${saved.provider}/${saved.modelId} is unavailable. Select an available model explicitly before sending.` };
    } finally {
        constructing = false;
    }
}
