const { DeliverableService } = require('./pi-deliverables');
function mountFilePreviews(router, { files, store, supervisor, access }) {
    const deliveries = new DeliverableService({ store, supervisor });
    const route = action => async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
        try { res.json(await action(req.query)); }
        catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
    };
    // Bytes travel as authenticated JSON. Neither HTML nor SVG is served as an
    // executable workbench-origin document, including direct URL navigation.
    router.get('/files/preview', route(input => files.preview(input)));
    router.get('/deliverables', route(input => deliveries.request(input)));
    const download = action => async (req, res) => {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', cancel);
        const authorize = () => {
            controller.signal.throwIfAborted();
            if (access && !access.validIdentity(req.workspaceIdentity)) throw Object.assign(new Error('访问已过期，请重新登录'), { status: 401, code: 'FILE_ACCESS' });
        };
        try { await action(req.query, { res, signal: controller.signal, authorize, head: req.method === 'HEAD' }); }
        catch (error) {
            if (res.headersSent || res.destroyed) res.destroy();
            else {
                for (const name of ['Content-Length', 'Content-Disposition', 'Content-Type']) res.removeHeader(name);
                res.status(error.status || 500).json({ error: error.status ? error.message : '文件下载未完成', code: error.code || 'FILE_READ' });
            }
        } finally { res.off('close', cancel); }
    };
    router.get('/files/download', download((input, options) => files.download(input, options)));
    router.get('/deliverables/download', download((input, options) => deliveries.request(input, options)));
    return deliveries;
}
module.exports = { mountFilePreviews };
