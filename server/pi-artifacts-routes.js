'use strict';
const { ArtifactsService } = require('./pi-artifacts');
function mountArtifacts(router, options) {
    const service = new ArtifactsService(options);
    const route = action => async (req, res) => {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
        try { const data = await action(req, controller.signal); if (!controller.signal.aborted) res.json(data); }
        catch (error) {
            if (!controller.signal.aborted) res.status(error.status || 500).json({ error: error.code && /^(ARTIFACT|DELIVERY|FILE)_/.test(error.code) ? error.message : '成果暂时无法读取，请刷新目录', code: error.code || 'ARTIFACT_READ' });
        } finally { res.off('close', cancel); }
    };
    router.get('/artifacts', route((req, signal) => service.list(req.query, signal)));
    router.get('/artifacts/library', route((req, signal) => service.job(() => service.library.list(req.query, cwd => { try { service.qualify({ cwd }); return true; } catch { return false; } }), signal)));
    router.post('/artifacts/batch', route((req, signal) => service.management.batch(req.body, signal)));
    router.get('/artifacts/operations/:requestId', route(req => service.management.result(req.params.requestId)));
    router.get('/artifacts/:key/location', route((req, signal) => service.management.location(req.params.key, signal)));
    router.get('/artifacts/:key/preview', route((req, signal) => service.preview(req.params.key, signal)));
    router.get('/artifacts/:key/cover', route((req, signal) => service.preview(req.params.key, signal, true)));
    router.get('/artifacts/:key/origin', route((req, signal) => service.origin(req.params.key, signal)));
    return service;
}
module.exports = { mountArtifacts };
