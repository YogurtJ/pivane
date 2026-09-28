const { DeliverableService } = require('./pi-deliverables');
function mountFilePreviews(router, { files, store, supervisor }) {
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
    return deliveries;
}
module.exports = { mountFilePreviews };
