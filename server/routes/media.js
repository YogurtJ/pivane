const path = require('node:path');
const { PiReplyTtsService } = require('../pi-reply-tts-service');
const { connectionSchema, createConnectionDraft } = require('../media-connection-planner');
const { installMediaModel } = require('../media-lab-models');

// The authenticated gateway mounts this adapter. Planning, tickets, execution
// and credential mutations remain owned by the corresponding media services.
function mountMediaRoutes(router, { mediaAgentService, mediaLabService: lab, preferences, store }) {
    router.get('/media/capabilities/:kind', (req, res) => {
        if (!mediaAgentService) return res.status(503).json({ error: 'Media Agent is not available' });
        try { res.json(mediaAgentService.getCapabilities(req.params.kind)); }
        catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
    });
    router.post('/media/plan', async (req, res) => {
        if (!mediaAgentService) return res.status(503).json({ error: 'Media Agent is not available' });
        try { res.json(await mediaAgentService.createPlan({ ...req.body, cwd: store.resolveProject(req.body.cwd || process.cwd()) })); }
        catch (error) { res.status(error.statusCode || 500).json({ error: error.message }); }
    });
    if (!lab) return;
    const respond = handler => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await handler(req)); }
        catch (error) { res.status(error.statusCode || 500).json({ error: error.message, ...(error.taskId ? { taskId: error.taskId } : {}) }); }
    };
    const planningCwd = req => {
        let cwd;
        try { cwd = store.resolveProject(req.body.cwd || process.cwd()); }
        catch (error) { throw Object.assign(error, { statusCode: 400 }); }
        if (!mediaAgentService) throw Object.assign(new Error('Media planner is unavailable'), { statusCode: 503 });
        return cwd;
    };
    router.use('/media/lab', (req, res, next) => {
        if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'A JSON request object is required' });
        next();
    });
    const replyTts = new PiReplyTtsService(lab, preferences);
    router.get('/settings/reply-tts', respond(() => replyTts.snapshot()));
    router.put('/settings/reply-tts', respond(req => replyTts.save(req.body)));
    router.get('/media/lab', respond(() => lab.catalog()));
    router.get('/media/lab/activity', respond(() => ({ running: lab.inFlight, connectionMutation: Boolean(lab.providerService?.busy), connectionOperations: lab.providerService?.active || 0 })));
    router.get('/media/lab/execution/:ticket', respond(req => lab.executionStatus(req.params.ticket)));
    if (lab.providerService) {
        const providers = lab.providerService;
        router.get('/media/lab/connections', respond(async () => ({ ...await providers.snapshot(), ...connectionSchema() })));
        router.post('/media/lab/providers', respond(req => providers.saveProvider(req.body)));
        router.delete('/media/lab/providers/:id', respond(req => providers.removeProvider(req.params.id, req.body)));
        router.post('/media/lab/providers/:id/key', respond(req => providers.setKey(req.params.id, req.body)));
        router.delete('/media/lab/providers/:id/key', respond(req => providers.removeKey(req.params.id, req.body)));
        router.post('/media/lab/providers/:id/probe', respond(req => {
            if (req.body.confirmed !== true || !['connection', 'models'].includes(req.body.mode)) throw Object.assign(new Error('Choose and confirm a read-only provider probe'), { statusCode: 400 });
            return providers.probe(req.params.id, req.body.mode === 'models');
        }));
        router.post('/media/lab/providers/:id/models', respond(req => providers.saveModel(req.params.id, req.body)));
        router.delete('/media/lab/providers/:id/models/:modelId', respond(req => providers.removeModel(req.params.id, req.params.modelId, req.body)));
        router.post('/media/lab/connection-plan', respond(req => createConnectionDraft(mediaAgentService, providers, { ...req.body, cwd: planningCwd(req) })));
    }
    router.post('/media/lab/models', respond(async req => {
        if ((await lab.models()).some(model => model.id === req.body.model?.id)) throw Object.assign(new Error('Model ID already exists'), { statusCode: 409 });
        return installMediaModel(lab.profile, req.body);
    }));
    router.get('/media/lab/docs', (req, res) => res.type('text/markdown').sendFile(path.join(__dirname, '..', '..', 'docs', 'MEDIA_LAB.md')));
    router.get('/media/lab/history', respond(req => lab.history(req.query.kind)));
    router.delete('/media/lab/history/:kind/:id', respond(req => lab.deleteMedia(req.params.kind, req.params.id)));
    router.post('/media/lab/review', respond(req => lab.review(req.body)));
    router.post('/media/lab/execute', respond(req => {
        if (req.body.confirmed !== true || typeof req.body.ticket !== 'string' || Object.keys(req.body).some(key => !['ticket', 'confirmed'].includes(key))) {
            throw Object.assign(new Error('An explicit reviewed ticket is required'), { statusCode: 400 });
        }
        return lab.execute(req.body.ticket);
    }));
    router.post('/media/lab/plan', respond(req => {
        const cwd = planningCwd(req);
        return mediaAgentService.createLabPlan({ ...req.body, cwd });
    }));
}
module.exports = { mountMediaRoutes };
