// REST adaptation for saved settings. Runtime/WebSocket operations remain in
// the gateway; services own configuration locks, revisions and persistence.
function mountSettingsRoutes(router, { settingsService, nativeService, auxiliaryModels, titles, preferences, usage, store }) {
    router.use('/settings', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body !== undefined
            && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'A JSON object is required' });
        next();
    });
    const route = (method, url, action, { errorStatus = 400, successStatus = 200, serviceStatus = true } = {}) => {
        router[method](url, async (req, res) => {
            try { res.status(successStatus).json(await action(req)); }
            catch (error) { res.status(serviceStatus && error.statusCode || errorStatus).json({ error: error.message }); }
        });
    };
    route('get', '/settings/model-favorites', () => preferences.getModelFavorites());
    route('post', '/settings/model-favorites', req => preferences.changeModelFavorites(req.body));
    route('get', '/settings/auxiliary-models', () => auxiliaryModels.snapshot());
    route('put', '/settings/auxiliary-models', req => auxiliaryModels.save(req.body));
    route('get', '/settings/session-titles', () => preferences.getSessionTitles());
    route('put', '/settings/session-titles', req => titles.saveSettings(req.body));
    route('get', '/settings/usage', req => usage.report(req.query));
    route('post', '/settings/providers/:id/login', req => {
        if (settingsService.mutating || nativeService.busy) throw Object.assign(new Error('设置正在保存，请稍后再试'), { statusCode: 409 });
        return settingsService.loginService.start(req.params.id, req.body?.method);
    });
    route('get', '/settings/login/:id', req => settingsService.loginService.snapshot(req.params.id));
    route('post', '/settings/login/:id/answer', req => settingsService.loginService.answer(req.params.id, req.body));
    route('delete', '/settings/login/:id', req => settingsService.loginService.cancel(req.params.id));
    route('put', '/settings/models/thinking', req => settingsService.saveModelThinking(req.body));
    route('get', '/settings/models', () => settingsService.getModelSnapshot(), { errorStatus: 500, serviceStatus: false });
    route('post', '/settings/providers/:id/api-key', req => settingsService.saveApiKey(req.params.id, req.body.apiKey));
    route('delete', '/settings/providers/:id/credential', req => settingsService.logout(req.params.id));
    route('post', '/settings/models/refresh', () => settingsService.refreshModels(), { errorStatus: 502, serviceStatus: false });
    route('post', '/settings/models/preferences', req => settingsService.setModelPreferences(req.body));
    route('patch', '/settings/media-agent', req => settingsService.setMediaAgentModel(req.body), { serviceStatus: false });
    route('post', '/settings/models/test', req => settingsService.testModel(req.body), { errorStatus: 502, serviceStatus: false });
    route('post', '/settings/custom-providers', req => settingsService.upsertCustomProvider(req.body));
    route('delete', '/settings/custom-providers/:providerId', req => settingsService.deleteCustomProvider(req.params.providerId));
    route('post', '/settings/custom-providers/:providerId/models', req => settingsService.upsertCustomModel(req.params.providerId, req.body));
    route('delete', '/settings/custom-providers/:providerId/models/:modelId', req => settingsService.deleteCustomModel(req.params.providerId, req.params.modelId));
    route('get', '/settings/resources', req => settingsService.getResourceSnapshot(store.resolveProject(req.query.cwd || process.cwd())), { serviceStatus: false });
    route('post', '/settings/packages/action', req => settingsService.packageAction({ ...req.body, cwd: store.resolveProject(req.body.cwd || process.cwd()) }), { serviceStatus: false });
    route('post', '/settings/skills', req => settingsService.createSkill(req.body), { successStatus: 201, serviceStatus: false });
    route('delete', '/settings/skills/:name', req => settingsService.deleteSkill(req.params.name), { serviceStatus: false });
    route('patch', '/settings/skill-commands', req => settingsService.setSkillCommands(req.body.enabled, store.resolveProject(req.body.cwd || process.cwd())), { serviceStatus: false });
}
module.exports = { mountSettingsRoutes };
