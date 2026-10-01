const fail = code => Object.assign(new Error(code), { code, statusCode: 409 });
// Only the registered existing worker may manage its native MCP connections.
function mountMcpRuntimeRoutes(router, { store, supervisor, settingsService, nativeService, mcpSettingsService }) {
    const handle = read => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const source = read ? req.query : req.body;
            if (!source || Object.keys(source).some(key => !['cwd', 'runtimeId', 'action', 'server', 'confirmed'].includes(key))) throw fail('MCP_INVALID_ACTION');
            const session = await store.getSession(source.cwd, req.params.id);
            const worker = supervisor.getActiveWorker(session.path);
            if (!worker || worker.disposed || worker.restarting || worker.noSession || worker.cwd !== session.cwd
                || worker.sessionId !== session.id || source.runtimeId !== worker.shell.runtimeId) throw fail('MCP_RUNTIME_CHANGED');
            if (!read && source.action !== 'snapshot') {
                settingsService.loginService.assertIdle();
                if (settingsService.mutating || nativeService.busy || mcpSettingsService.busy) throw fail('MCP_SETTINGS_BUSY');
            }
            const { cwd, ...input } = source;
            const data = await worker.mcpControl.request(read ? { action: 'snapshot', runtimeId: input.runtimeId } : input);
            if (supervisor.getActiveWorker(session.path) !== worker || worker.disposed) throw fail('MCP_RUNTIME_CHANGED');
            res.json(data);
        } catch (error) {
            const code = /^MCP_[A-Z_]+$/.test(error?.code || '') ? error.code : error?.code === 'SESSION_BUSY' ? 'MCP_RUNTIME_BUSY' : 'MCP_REQUEST_FAILED';
            res.status(error?.statusCode || error?.status || 409).json({ error: code, code });
        }
    };
    router.get('/sessions/:id/mcp', handle(true));
    router.post('/sessions/:id/mcp', handle(false));
}
module.exports = { mountMcpRuntimeRoutes };
