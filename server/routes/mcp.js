// Mount behind the gateway's existing access/origin checks. No runtime route here.
function mountMcpSettingsRoutes(router, { mcpSettingsService, settingsService }) {
    const handle = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await action(req)); }
        catch (error) { const safe = /^MCP_[A-Z_]+$/.test(error.code || ''); res.status(safe ? error.statusCode || 400 : 500).json({ error: safe ? error.code : 'MCP_REQUEST_FAILED', code: safe ? error.code : 'MCP_REQUEST_FAILED' }); }
    };
    router.get('/settings/mcp', handle(req => mcpSettingsService.snapshot(req.query.cwd, req.query.scope)));
    router.put('/settings/mcp', handle(req => {
        if (settingsService?.mutating || settingsService?.loginService?.busy) throw Object.assign(new Error('MCP_SETTINGS_BUSY'), { code: 'MCP_SETTINGS_BUSY', statusCode: 409 });
        return mcpSettingsService.save(req.body);
    }));
}
module.exports = { mountMcpSettingsRoutes };
