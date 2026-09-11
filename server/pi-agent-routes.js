const express = require('express');
const path = require('path');
const { randomUUID } = require('node:crypto');
const { version: PI_VERSION } = require('../node_modules/@earendil-works/pi-coding-agent/package.json');
const { WebSocketServer, WebSocket } = require('ws');
const { PiAgentSupervisor } = require('./pi-agent-supervisor');
const { PiSessionStore } = require('./pi-session-store');
const { PiSettingsService } = require('./pi-settings-service');
const { WorkspacePreferencesService } = require('./workspace-preferences-service');
const { PiDeferredMessages } = require('./pi-deferred-messages');
const { mountSessionWorkflows } = require('./pi-session-workflows');
const { INTERNAL_COMMAND } = require('./pi-message-payload');
const { descriptorBackendAvailable } = require('./pi-file-descriptor');
const { PiSideChatService } = require('./pi-side-chat');

const ALLOWED_RPC_COMMANDS = new Set([
    'prompt',
    'steer',
    'follow_up',
    'abort',
    'get_state',
    'get_messages',
    'get_session_stats',
    'get_available_models',
    'set_model',
    'cycle_model',
    'get_available_thinking_levels',
    'set_thinking_level',
    'cycle_thinking_level',
    'compact',
    'set_auto_compaction',
    'set_auto_retry',
    'abort_retry',
    'get_entries',
    'get_tree',
    'get_fork_messages',
    'set_session_name',
    'get_commands'
]);

const LONG_RUNNING_COMMANDS = new Set(['compact']);

function safeSend(socket, payload) {
    if (socket.workspaceAccess && !socket.workspaceAccess.validIdentity(socket.workspaceIdentity)) {
        socket.close(4401, 'Access expired or revoked');
        return;
    }
    if (payload.type === 'gateway_shell' && socket.bufferedAmount > 1024 * 1024) {
        socket.close(1013, 'Shell output consumer too slow; reconnect for snapshot');
        return;
    }
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function validateRpcPayload(command, payload) {
    if (['set_auto_compaction', 'set_auto_retry'].includes(command) && typeof payload.enabled !== 'boolean') {
        throw new Error('Enabled must be a boolean');
    }
    if (command === 'compact' && payload.customInstructions !== undefined
        && (typeof payload.customInstructions !== 'string' || payload.customInstructions.length > 10000)) {
        throw new Error('Compaction instructions must be a string of at most 10000 characters');
    }
    if (command !== 'prompt' && command !== 'steer' && command !== 'follow_up') return;
    const message = String(payload.message || '');
    if (/^\s*\/btw(?:\s|$)/.test(message)) throw new Error('请通过 Web 侧聊入口发送 BTW 问题');
    if (new RegExp(`^\\s*/${INTERNAL_COMMAND}(?:\\s|:|$)`).test(message)) throw new Error('Internal navigation command is not allowed');
    if (message.length > 400000) throw new Error('Message is too large');
    const images = Array.isArray(payload.images) ? payload.images : [];
    if (images.length > 6) throw new Error('A maximum of 6 images can be sent at once');
    let encodedBytes = 0;
    for (const image of images) {
        if (!/^image\/(png|jpeg|webp|gif)$/i.test(String(image.mimeType || ''))) {
            throw new Error('Unsupported image attachment type');
        }
        encodedBytes += String(image.data || '').length;
    }
    if (encodedBytes > 24 * 1024 * 1024) throw new Error('Image attachments are too large');
}

function createPiAgentGateway(options = {}) {
    const access = options.accessService || new (require('./workspace-access-service').WorkspaceAccessService)();
    const supervisor = new PiAgentSupervisor();
    const store = new PiSessionStore();
    const preferences = options.workspacePreferencesService || new WorkspacePreferencesService();
    const composer = new (require('./pi-composer-service').PiComposerService)(store);
    const files = new (require('./pi-file-service').PiFileService)(store);
    const usage = new (require('./pi-usage-service').PiUsageService)(store);
    const sessionSearch = new (require('./pi-session-search').PiSessionSearch)(store, preferences);
    const settingsService = new PiSettingsService({ workspacePreferencesService: preferences });
    const nativeService = new (require('./pi-native-service').PiNativeService)(store);
    const resourceService = new (require('./pi-resource-service').PiResourceService)(nativeService);
    settingsService.nativeService = nativeService;
    const mediaAgentService = options.mediaAgentService || null;
    const router = express.Router();
    const deferred = new PiDeferredMessages({ store, supervisor, filePath: options.deferredFilePath });
    const sideChat = new PiSideChatService({ store, supervisor });
    const notifications = new (require('./pi-notification-service').PiNotificationService)({ access, store });
    supervisor.on('attention', event => { void notifications.notify(event); });
    supervisor.on('completion', notice => {
        void notifications.notify(notice);
        try { preferences.recordReplyNotice(notice); }
        catch { console.error('Pi reply notice could not be persisted'); }
    });

    router.use(access.middleware());
    notifications.mount(router);

    router.get('/status', (req, res) => {
        res.json({
            ok: true,
            version: PI_VERSION,
            authRequired: access.configuration().enabled,
            browserNotifications: true,
            accessControl: true,
            projectRoots: store.roots,
            defaultProject: store.defaultProject(),
            nativeResources: true,
            nativeSettings: true,
            projectTrust: true,
            modelAdvanced: true,
            sessionTransfer: true,
            runtimeConfiguration: true,
            sessionSearch: descriptorBackendAvailable(),
            liveRecovery: true,
            extensionDrafts: true,
            historySearch: true,
            sessionTree: true,
            treePresentation: true,
            historyBody: true,
            historyPresentation: true,
            composerTools: true,
            modelCatalog: true,
            fileViewer: descriptorBackendAvailable(),
            usageStats: descriptorBackendAvailable(),
            runtimeControls: true,
            userShell: true,
            queueModes: true,
            providerLogin: true,
            modelThinking: true,
            extensionStatus: true,
            sessionWorkflows: true,
            replyFork: true,
            sideChat: true,
            sideChatContext: true,
            sideChatRetention: true,
            manualUnread: true,
            projectIdentity: true,
            replyTts: Boolean(options.mediaLabService),
            mediaLab: Boolean(options.mediaLabService),
            mediaConnections: Boolean(options.mediaLabService?.providerService)
        });
    });

    const nativeRoute = (action, mutation = false) => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            if (mutation) {
                settingsService.loginService.assertIdle();
                if (settingsService.mutating || nativeService.busy) throw Object.assign(new Error('设置正在保存，请稍后再试'), { status: 409 });
            }
            res.json(await action(req));
        } catch (error) { res.status(error.status || error.statusCode || 400).json({ error: error.message }); }
    };
    router.get('/settings/native', nativeRoute(req => nativeService.snapshot(req.query.cwd)));
    router.put('/settings/native', nativeRoute(req => nativeService.saveSettings(req.body), true));
    router.put('/settings/native/trust', nativeRoute(req => nativeService.saveTrust(req.body), true));
    router.get('/settings/native/resources', nativeRoute(req => resourceService.snapshot(req.query.cwd, req.query.scope || 'project')));
    router.put('/settings/native/resources', nativeRoute(req => resourceService.toggle(req.body), true));
    router.post('/settings/native/packages', nativeRoute(req => resourceService.packageAction(req.body), true));
    router.get('/settings/native/skill', nativeRoute(req => resourceService.readSkill(req.query)));
    router.put('/settings/native/skill', nativeRoute(req => resourceService.saveSkill(req.body), true));
    router.get('/settings/models/advanced', nativeRoute(req => settingsService.getModelAdvanced(req.query)));
    router.put('/settings/models/advanced', nativeRoute(req => settingsService.saveModelAdvanced(req.body), true));

    router.get('/sessions/search', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        try { const data = await sessionSearch.search(req.query, controller.signal); if (!controller.signal.aborted) res.json(data); }
        catch (error) { if (!controller.signal.aborted) res.status(error.status || 500).json({ error: error.message }); }
        finally { res.off('close', cancel); }
    });
    router.get('/files/content', async (req, res) => {
        res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        try { res.json(await files.content(req.query)); }
        catch (error) { res.status(error.status || 500).json({ error: error.message, code: error.code }); }
    });

    const composerRoute = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await action(req)); }
        catch (error) { res.status(error.status || 400).json({ error: error.message }); }
    };
    router.get('/composer/catalog', composerRoute(req => composer.list(req.query.cwd)));
    router.get('/composer/template', composerRoute(req => composer.get(req.query)));
    router.put('/composer/template', composerRoute(req => composer.save(req.body)));
    router.delete('/composer/template', composerRoute(req => composer.save(req.body, true)));
    router.get('/composer/files', composerRoute(req => composer.files(req.query.cwd, req.query.q || '')));

    function pinnedProjects() {
        return preferences.getPinnedProjects().filter(cwd => {
            try { return store.resolveProject(cwd) === cwd; } catch { return false; }
        });
    }

    function hiddenProjects() {
        return preferences.getHiddenProjects().filter(cwd => {
            try { return store.resolveProject(cwd) === cwd; } catch { return false; }
        });
    }

    router.patch('/projects/visibility', async (req, res) => {
        try {
            const cwd = store.resolveProject(req.body.cwd);
            if (typeof req.body.hidden !== 'boolean') throw new Error('Hidden must be a boolean');
            if (req.body.hidden) {
                const sessions = await store.listSessions(cwd);
                if (sessions.length || supervisor.hasProjectRuntime(cwd)) {
                    return res.status(409).json({ error: '项目仍有会话或运行实例，不能从列表移除' });
                }
            }
            preferences.setProjectHidden(cwd, req.body.hidden);
            res.json({ cwd, hiddenProjects: hiddenProjects(), pinnedProjects: pinnedProjects() });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });

    function replyNotices() {
        return preferences.getReplyNotices().filter(item => {
            try { return store.resolveProject(item.cwd) === item.cwd; } catch { return false; }
        });
    }

    function replyNotice(session) {
        return preferences.getReplyNotices().find(item => item.cwd === session.cwd && item.sessionId === session.id) || null;
    }

    router.patch('/sessions/:id/read', (req, res) => {
        try {
            const cwd = store.resolveProject(req.body.cwd);
            if (typeof req.body.completionId !== 'string' || !req.body.completionId) throw new Error('Completion ID is required');
            preferences.clearReplyNotice(cwd, req.params.id, req.body.completionId);
            res.json({ ok: true });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });

    router.patch('/sessions/:id/unread', async (req, res) => {
        try {
            const session = await store.getSession(req.body.cwd, req.params.id);
            const notice = { cwd: session.cwd, sessionId: session.id, completionId: randomUUID(),
                completedAt: new Date().toISOString(), manual: true };
            preferences.recordReplyNotice(notice);
            res.json({ notice });
        } catch (error) { res.status(400).json({ error: error.message }); }
    });

    router.get('/activity', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json({ runtimes: supervisor.getActivity(), nativeSettingsBusy: nativeService.busy || settingsService.mutating, sessionTransfers: sessionTransfer.running, pinnedProjects: pinnedProjects(), hiddenProjects: hiddenProjects(), replyNotices: replyNotices(), deferred: deferred.summary() });
    });

    router.patch('/projects/pin', (req, res) => {
        try {
            const cwd = store.resolveProject(req.body.cwd);
            preferences.setProjectPinned(cwd, req.body.pinned);
            res.json({ pinnedProjects: pinnedProjects(), hiddenProjects: hiddenProjects() });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.get('/projects/resolve', (req, res) => {
        try { res.json({ cwd: store.resolveProject(req.query.cwd) }); }
        catch (error) { res.status(400).json({ error: error.message }); }
    });

    router.get('/projects', async (req, res) => {
        try {
            let recent = [];
            if (req.query.recent !== undefined) {
                try { recent = JSON.parse(req.query.recent); }
                catch { return res.status(400).json({ error: 'Recent projects must be a JSON array' }); }
            }
            if (!Array.isArray(recent) || recent.length > 64 || recent.some(cwd => typeof cwd !== 'string' || cwd.length > 4096)) {
                return res.status(400).json({ error: 'Recent projects must be an array of at most 64 paths' });
            }
            const projectAliases = recent.map(input => {
                try { return { input, cwd: store.resolveProject(input) }; }
                catch { return { input, cwd: null }; }
            });
            const projects = await store.listProjects();
            const pins = pinnedProjects();
            const hidden = hiddenProjects();
            for (const cwd of new Set([...pins, ...hidden])) {
                if (!projects.some(project => project.cwd === cwd)) {
                    projects.push({ cwd, name: path.basename(cwd), sessionCount: 0, modified: null });
                }
            }
            res.json({ projects, roots: store.roots, pinnedProjects: pins, hiddenProjects: hidden, projectAliases });
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.get('/directories', async (req, res) => {
        try {
            res.json(await store.listDirectories(req.query.path));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.get('/sessions', async (req, res) => {
        try {
            res.json({ sessions: await store.listSessions(req.query.cwd) });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/sessions', async (req, res) => {
        try {
            const session = await store.createSession(req.body.cwd, req.body.name);
            if (preferences.getHiddenProjects().includes(session.cwd)) preferences.setProjectHidden(session.cwd, false);
            res.status(201).json(session);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.patch('/sessions/:id', async (req, res) => {
        try {
            const session = await store.getSession(req.body.cwd, req.params.id);
            const worker = supervisor.getActiveWorker(session.path);
            res.json(await store.renameSession(req.body.cwd, req.params.id, req.body.name, worker));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/sessions/:id', async (req, res) => {
        try {
            const session = await store.getSession(req.query.cwd, req.params.id);
            const worker = await supervisor.getWorker({ cwd: session.cwd, sessionId: session.id, sessionPath: session.path });
            const deleted = await worker.exclusive(async () => {
                deferred.cancelSession(session.cwd, session.id);
                await sideChat.releaseSource(session.cwd, session.id, 'deleted');
                worker._broadcast({ type: 'gateway_reconnect' });
                await supervisor.stopSession(session.path);
                return store.deleteSession(req.query.cwd, req.params.id);
            }, { idle: false });
            preferences.clearReplyNotice(session.cwd, session.id);
            res.json(deleted);
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    mountSessionWorkflows(router, { store, supervisor, deferred, preferences });
    const sessionTransfer = require('./pi-session-transfer').mountSessionTransfer(router, { store, supervisor, preferences });

    router.use('/settings', (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (['POST', 'PUT', 'PATCH'].includes(req.method) && req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'A JSON object is required' });
        next();
    });
    const settingsAction = handler => async (req, res) => {
        try { res.json(await handler(req)); }
        catch (error) { res.status(error.statusCode || 400).json({ error: error.message }); }
    };
    router.get('/settings/usage', settingsAction(req => usage.report(req.query)));
    router.post('/settings/providers/:id/login', settingsAction(req => {
        if (settingsService.mutating || nativeService.busy) throw Object.assign(new Error('设置正在保存，请稍后再试'), { statusCode: 409 });
        return settingsService.loginService.start(req.params.id, req.body?.method);
    }));
    router.get('/settings/login/:id', settingsAction(req => settingsService.loginService.snapshot(req.params.id)));
    router.post('/settings/login/:id/answer', settingsAction(req => settingsService.loginService.answer(req.params.id, req.body)));
    router.delete('/settings/login/:id', settingsAction(req => settingsService.loginService.cancel(req.params.id)));
    router.put('/settings/models/thinking', settingsAction(req => settingsService.saveModelThinking(req.body)));

    router.get('/settings/models', async (req, res) => {
        try {
            res.json(await settingsService.getModelSnapshot());
        } catch (error) {
            res.status(500).json({ error: error.message });
        }
    });

    router.post('/settings/providers/:id/api-key', async (req, res) => {
        try {
            res.json(await settingsService.saveApiKey(req.params.id, req.body.apiKey));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.delete('/settings/providers/:id/credential', async (req, res) => {
        try {
            res.json(await settingsService.logout(req.params.id));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.post('/settings/models/refresh', async (req, res) => {
        try {
            res.json(await settingsService.refreshModels());
        } catch (error) {
            res.status(502).json({ error: error.message });
        }
    });

    router.post('/settings/models/preferences', async (req, res) => {
        try {
            res.json(await settingsService.setModelPreferences(req.body));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.patch('/settings/media-agent', async (req, res) => {
        try {
            res.json(await settingsService.setMediaAgentModel(req.body));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/settings/models/test', async (req, res) => {
        try {
            res.json(await settingsService.testModel(req.body));
        } catch (error) {
            res.status(502).json({ error: error.message });
        }
    });

    router.post('/settings/custom-providers', async (req, res) => {
        try {
            res.json(await settingsService.upsertCustomProvider(req.body));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.delete('/settings/custom-providers/:providerId', async (req, res) => {
        try {
            res.json(await settingsService.deleteCustomProvider(req.params.providerId));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.post('/settings/custom-providers/:providerId/models', async (req, res) => {
        try {
            res.json(await settingsService.upsertCustomModel(req.params.providerId, req.body));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.delete('/settings/custom-providers/:providerId/models/:modelId', async (req, res) => {
        try {
            res.json(await settingsService.deleteCustomModel(req.params.providerId, req.params.modelId));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.get('/settings/resources', async (req, res) => {
        try {
            const cwd = store.resolveProject(req.query.cwd || process.cwd());
            res.json(await settingsService.getResourceSnapshot(cwd));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/settings/packages/action', async (req, res) => {
        try {
            const cwd = store.resolveProject(req.body.cwd || process.cwd());
            res.json(await settingsService.packageAction({ ...req.body, cwd }));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.post('/settings/skills', async (req, res) => {
        try {
            res.status(201).json(await settingsService.createSkill(req.body));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.delete('/settings/skills/:name', async (req, res) => {
        try {
            res.json(await settingsService.deleteSkill(req.params.name));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.patch('/settings/skill-commands', async (req, res) => {
        try {
            const cwd = store.resolveProject(req.body.cwd || process.cwd());
            res.json(await settingsService.setSkillCommands(req.body.enabled, cwd));
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    });

    router.get('/media/capabilities/:kind', (req, res) => {
        if (!mediaAgentService) return res.status(503).json({ error: 'Media Agent is not available' });
        try {
            res.json(mediaAgentService.getCapabilities(req.params.kind));
        } catch (error) {
            res.status(error.statusCode || 400).json({ error: error.message });
        }
    });

    router.post('/media/plan', async (req, res) => {
        if (!mediaAgentService) return res.status(503).json({ error: 'Media Agent is not available' });
        try {
            const cwd = store.resolveProject(req.body.cwd || process.cwd());
            res.json(await mediaAgentService.createPlan({ ...req.body, cwd }));
        } catch (error) {
            res.status(error.statusCode || 500).json({ error: error.message });
        }
    });

    if (options.mediaLabService) {
        const lab = options.mediaLabService;
        const respond = handler => async (req, res) => {
            res.set('Cache-Control', 'no-store');
            try { res.json(await handler(req)); }
            catch (error) { res.status(error.statusCode || 500).json({ error: error.message, ...(error.taskId ? { taskId: error.taskId } : {}) }); }
        };
        router.use('/media/lab', (req, res, next) => {
            if (req.method === 'POST' && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return res.status(400).json({ error: 'A JSON request object is required' });
            next();
        });
        const replyTts = new (require('./pi-reply-tts-service').PiReplyTtsService)(lab, preferences);
        router.get('/settings/reply-tts', respond(() => replyTts.snapshot()));
        router.put('/settings/reply-tts', respond(req => replyTts.save(req.body)));
        router.get('/media/lab', respond(() => lab.catalog()));
        router.get('/media/lab/activity', respond(() => ({ running: lab.inFlight, connectionMutation: Boolean(lab.providerService?.busy), connectionOperations: lab.providerService?.active || 0 })));
        router.get('/media/lab/execution/:ticket', respond(req => lab.executionStatus(req.params.ticket)));
        if (lab.providerService) {
            const providers = lab.providerService;
            router.get('/media/lab/connections', respond(async () => ({ ...await providers.snapshot(), ...require('./media-connection-planner').connectionSchema() })));
            router.post('/media/lab/providers', respond(req => providers.saveProvider(req.body)));
            router.delete('/media/lab/providers/:id', respond(req => providers.removeProvider(req.params.id, req.body)));
            router.post('/media/lab/providers/:id/key', respond(req => providers.setKey(req.params.id, req.body)));
            router.delete('/media/lab/providers/:id/key', respond(req => providers.removeKey(req.params.id, req.body)));
            router.post('/media/lab/providers/:id/probe', respond(req => {
                if (req.body.confirmed !== true || !['connection','models'].includes(req.body.mode)) throw Object.assign(new Error('Choose and confirm a read-only provider probe'), { statusCode: 400 });
                return providers.probe(req.params.id, req.body.mode === 'models');
            }));
            router.post('/media/lab/providers/:id/models', respond(req => providers.saveModel(req.params.id, req.body)));
            router.delete('/media/lab/providers/:id/models/:modelId', respond(req => providers.removeModel(req.params.id, req.params.modelId, req.body)));
            router.post('/media/lab/connection-plan', respond(req => {
                let cwd;
                try { cwd = store.resolveProject(req.body.cwd || process.cwd()); }
                catch (error) { throw Object.assign(error, { statusCode: 400 }); }
                if (!mediaAgentService) throw Object.assign(new Error('Media planner is unavailable'), { statusCode: 503 });
                return require('./media-connection-planner').createConnectionDraft(mediaAgentService, providers, { ...req.body, cwd });
            }));
        }
        router.post('/media/lab/models', respond(async req => {
            if ((await lab.models()).some(model => model.id === req.body.model?.id)) throw Object.assign(new Error('Model ID already exists'), { statusCode: 409 });
            return require('./media-lab-models').installMediaModel(lab.profile, req.body);
        }));
        router.get('/media/lab/docs', (req, res) => res.type('text/markdown').sendFile(path.join(__dirname, '..', 'docs', 'MEDIA_LAB.md')));
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
            let cwd;
            try { cwd = store.resolveProject(req.body.cwd || process.cwd()); }
            catch (error) { throw Object.assign(error, { statusCode: 400 }); }
            if (!mediaAgentService) throw Object.assign(new Error('Media planner is unavailable'), { statusCode: 503 });
            return mediaAgentService.createLabPlan({ ...req.body, cwd });
        }));
    }

    function mount(app) {
        app.use('/api/pi', router);
    }

    function attachWebSocket(server) {
        const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });

        server.on('upgrade', (req, socket, head) => {
            let pathname;
            try {
                pathname = new URL(req.url, 'http://localhost').pathname;
            } catch {
                socket.destroy();
                return;
            }
            if (pathname !== '/api/pi/ws') {
                socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
                socket.destroy();
                return;
            }
            if (!access.originAllowed(req)) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }
            if (wss.clients.size >= 128) {
                socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return;
            }
            wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
        });

        wss.on('connection', (socket, req) => {
            let worker = null;
            let workerSessionPath = null;
            let ephemeralWorker = null;
            let sideConnection = null;
            let sideSocket = false;
            let unsubscribe = null;
            let authenticated = false;
            let socketClosed = false;
            const authTimer = setTimeout(() => socket.close(4401, 'Authentication timeout'), 10000);
            authTimer.unref?.();

            socket.on('message', raw => {
                if (raw.length > (authenticated ? 32 * 1024 * 1024 : 16384)) {
                    socket.close(1009, 'Message too large');
                    return;
                }
                let message;
                try {
                    message = JSON.parse(raw.toString('utf8'));
                } catch {
                    safeSend(socket, { type: 'response', success: false, error: 'Invalid JSON message' });
                    return;
                }

                if (!message || typeof message !== 'object' || Array.isArray(message) || typeof message.type !== 'string') {
                    safeSend(socket, { type: 'response', success: false, error: 'Invalid gateway command' });
                    return;
                }
                handleSocketMessage(message).catch(error => {
                    safeSend(socket, {
                        type: 'response',
                        id: message.id,
                        command: message.type,
                        success: false,
                        error: error.message,
                        errorCode: error.code
                    });
                });
            });

            async function releaseCurrentWorker(stopPersistent = false) {
                const source = worker;
                const stoppingSide = Promise.all([
                    stopPersistent && source ? sideChat.releaseSource(source.cwd, source.sessionId) : undefined,
                    sideChat.releaseParent(socket, { force: stopPersistent })
                ]);
                unsubscribe?.();
                unsubscribe = null;
                const ephemeral = ephemeralWorker;
                const persistentPath = workerSessionPath;
                ephemeralWorker = null;
                workerSessionPath = null;
                worker = null;

                await Promise.all([
                    stoppingSide,
                    ephemeral ? ephemeral.dispose() : stopPersistent && persistentPath ? supervisor.stopSession(persistentPath) : undefined
                ]);
            }

            async function buildSnapshot(session) {
                const completion = session.ephemeral ? null : replyNotice(session);
                const state = await worker.request('get_state');
                let messages;
                const stats = await worker.request('get_session_stats');
                const models = await worker.request('get_available_models', {}, 60000);
                const thinkingLevels = await worker.request('get_available_thinking_levels');
                const commands = await worker.request('get_commands');
                // Return one fresh controls snapshot, without duplicating potentially large recovered text.
                delete state.webControls;
                state.webShell = worker.shell.snapshot();
                // Read messages last. webLive is captured synchronously at the native response boundary.
                messages = await worker.request('get_messages');
                const live = messages.webLive, boundary = messages.webSnapshot;
                return { session, state: { ...state, ...(live ? { isStreaming: live.running, isCompacting: live.compacting,
                    webCompaction: boundary.webCompaction, webShell: boundary.webShell, webNavigation: boundary.webNavigation } : {}) },
                    messages, stats, models, thinkingLevels, commands, completion,
                    pendingUi: boundary?.pendingUi || worker.getPendingUi(), controls: boundary?.controls || worker.controls.snapshot() };
            }

            async function handleSocketMessage(message) {
                if (!authenticated) {
                    let identity;
                    try { identity = access.authenticate(req, message.token); } catch { socket.close(4401, 'Authentication failed'); return; }
                    if (!['open_session', 'open_ephemeral', 'open_side_chat'].includes(message.type) || !identity || !access.csrf(req, identity)) {
                        socket.close(4401, 'Authentication failed');
                        return;
                    }
                    socket.workspaceAccess = access;
                    socket.workspaceIdentity = identity;
                    access.trackSocket(socket, identity);
                    authenticated = true;
                    clearTimeout(authTimer);
                }
                if (!access.validIdentity(socket.workspaceIdentity)) { socket.close(4401, 'Access expired or revoked'); return; }

                if (message.type === 'open_side_chat') {
                    if (worker || sideSocket) throw new Error('侧聊必须使用独立的新连接');
                    sideSocket = true;
                    try {
                        sideConnection = sideChat.claim(message.ticket, socket, event => safeSend(socket, event));
                        const data = await sideConnection.ready;
                        if (socketClosed) { await sideConnection.dispose(); return; }
                        safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    } catch (error) { await sideConnection?.dispose(false); throw error; }
                    return;
                }
                if (sideSocket) {
                    if (!sideConnection) throw new Error('侧聊连接已失效，请重新打开');
                    const data = await sideConnection.handle(message);
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    if (message.type === 'quit_side_chat') socket.close(1000, 'Side chat ended');
                    return;
                }
                if (message.type === 'prepare_side_chat') {
                    const source = worker;
                    const data = await sideChat.prepare(socket, source, message, () => !socketClosed && worker === source);
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    return;
                }

                if (message.type === 'open_session' || message.type === 'open_ephemeral') {
                    await releaseCurrentWorker(false);
                    let session;
                    if (message.type === 'open_ephemeral') {
                        const cwd = store.resolveProject(message.cwd);
                        worker = await supervisor.createEphemeralWorker(cwd);
                        ephemeralWorker = worker;
                        if (socketClosed) {
                            await releaseCurrentWorker(false);
                            return;
                        }
                        const runtimeState = await worker.request('get_state');
                        const now = new Date().toISOString();
                        session = {
                            id: runtimeState.sessionId,
                            path: null,
                            cwd,
                            name: '临时会话',
                            firstMessage: '',
                            messageCount: 0,
                            created: now,
                            modified: now,
                            ephemeral: true
                        };
                    } else {
                        session = await store.getSession(message.cwd, message.sessionId);
                        worker = await supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
                        workerSessionPath = session.path;
                    }
                    unsubscribe = worker.subscribe(event => {
                        if (event.type === 'gateway_reconnect') socket.close(1012, 'Session runtime changed');
                        else safeSend(socket, event);
                    });
                    const snapshot = await buildSnapshot(session);
                    if (socketClosed) {
                        await releaseCurrentWorker(false);
                        return;
                    }
                    safeSend(socket, {
                        type: 'response',
                        id: message.id,
                        command: message.type,
                        success: true,
                        data: snapshot
                    });
                    return;
                }

                if (message.type === 'quit_session') {
                    if (!worker) throw new Error('No active Pi runtime');
                    if (worker.noSession) await releaseCurrentWorker(true);
                    else await worker.exclusive(async () => {
                        deferred.pauseSession(worker.cwd, worker.sessionId, 'runtime 已退出，请重新确认发送');
                        await releaseCurrentWorker(true);
                    }, { idle: false });
                    safeSend(socket, {
                        type: 'response',
                        id: message.id,
                        command: 'quit_session',
                        success: true,
                        data: { quit: true }
                    });
                    return;
                }

                if (!worker) throw new Error('Open a session before sending commands');
                if (message.type === 'navigate_history') {
                    const { id, type, token, ...input } = message;
                    const source = worker;
                    const data = await source.navigation.run(input, () => deferred.pauseSession(source.cwd, source.sessionId, '已切换对话位置，请重新确认发送'));
                    safeSend(socket, { type: 'response', id, command: type, success: true, data });
                    return;
                }
                if (message.type === 'cancel_history_navigation') {
                    if (Object.keys(message).some(k => !['id', 'type', 'token', 'navigationId'].includes(k)) || typeof message.navigationId !== 'string') throw new Error('取消导航需要对应的操作 ID');
                    const data = await worker.navigation.cancel(message.navigationId);
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    return;
                }
                if (['get_session_tree', 'search_history', 'get_history_entry', 'set_history_bookmark'].includes(message.type)) {
                    const kind = { get_session_tree: 'tree', search_history: 'search', get_history_entry: 'preview', set_history_bookmark: 'bookmark' }[message.type];
                    const { id, type, token, ...input } = message;
                    const data = await worker.historyRequest(kind, input);
                    safeSend(socket, { type: 'response', id, command: type, success: true, data });
                    return;
                }
                if (message.type === 'get_runtime_configuration') {
                    const source = worker;
                    const saved = await nativeService.snapshot(source.cwd);
                    const actual = await source.getNativeResources();
                    if (worker !== source || source.disposed) throw new Error('运行实例已变化，请重新核对配置');
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data: {
                        actualProjectTrusted: actual.projectTrusted,
                        runtimeId: source.controls.runtimeId, revision: saved.revision, matchesSavedConfig: source.configRevision == null ? null : source.configRevision === saved.revision,
                        trust: saved.trust, ephemeral: source.noSession,
                        recoveries: source.controls.recoveries.length, drafts: source.controls.drafts.length } });
                    return;
                }
                if (message.type === 'restart_runtime') {
                    const source = worker;
                    if (source.noSession || message.confirmed !== true || message.runtimeId !== source.controls.runtimeId) throw new Error('请确认重新打开当前持久线程的运行实例');
                    settingsService.loginService.assertIdle();
                    if (settingsService.mutating || nativeService.busy) throw new Error('配置正在保存，请稍后重试');
                    settingsService.mutating = true;
                    try {
                        await source.exclusive(async () => {
                            const saved = await nativeService.context(source.cwd);
                            if (message.expectedRevision !== saved.revision) throw new Error('配置已变化，请刷新核对后重新打开实例');
                            if (source.controls.recoveries.length || source.controls.drafts.length) throw new Error('请先处理运行队列取回内容和扩展草稿建议');
                            if ([...sideChat.connections].some(c => c.reference.source?.cwd === source.cwd && c.reference.source?.sessionId === source.sessionId)
                                || [...sideChat.parents.values()].some(p => p.preparing && p.source?.cwd === source.cwd && p.source?.sessionId === source.sessionId)) throw new Error('请先结束此线程的侧聊，再重新打开运行实例');
                            deferred.pauseSession(source.cwd, source.sessionId, '运行实例重新打开，请重新确认延迟发送');
                            safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data: { accepted: true } });
                            await supervisor.restartWorker(source);
                        });
                    } finally { settingsService.mutating = false; }
                    return;
                }
                if (message.type === 'refresh_models') {
                    if (Object.keys(message).some(k => !['id', 'type', 'token'].includes(k))) throw new Error('模型刷新不接收其他参数');
                    if (worker.modelCatalog.inflight) {
                        const data = await worker.modelCatalog.inflight;
                        safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                        return;
                    }
                    settingsService.loginService.assertIdle();
                    if (settingsService.mutating || nativeService.busy) throw new Error('供应商或配置正在处理，请完成后再刷新模型');
                    settingsService.mutating = true;
                    try {
                        const data = await worker.modelCatalog.refresh();
                        safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    } finally { settingsService.mutating = false; }
                    return;
                }
                if (message.type === 'get_native_resources') {
                    const data = await worker.getNativeResources();
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    return;
                }
                if (message.type === 'reload_resources') {
                    const data = await worker.reloadResources();
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    return;
                }
                if (message.type === 'extension_ui_response') {
                    const { type, token, ...response } = message;
                    if (worker.send({ type, ...response }) === false) {
                        safeSend(socket, { type: 'gateway_ui_resolved', id: response.id });
                    }
                    return;
                }
                if (message.type === 'ack_extension_draft') {
                    if (typeof message.draftId !== 'string' || message.runtimeId !== worker.controls.runtimeId) throw new Error('扩展建议已失效，请刷新核对');
                    worker.controls.ackDraft(message.draftId); worker.broadcastControls();
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data: worker.controls.snapshot() });
                    return;
                }
                if (['stop_and_recover', 'take_queue', 'ack_recovery'].includes(message.type)) {
                    const source = worker;
                    if (message.type === 'ack_recovery' && (typeof message.recoveryId !== 'string' || message.recoveryId.length > 100)) throw new Error('Invalid recovery ID');
                    const data = message.type === 'ack_recovery' ? source.acknowledgeRecovery(message.recoveryId)
                        : await source.recoverQueue(message.type === 'stop_and_recover');
                    safeSend(socket, { type: 'response', id: message.id, command: message.type, success: true, data });
                    return;
                }
                if (message.type === 'bash' || message.type === 'abort_bash') {
                    const { id, type, token, ...input } = message;
                    if (type === 'abort_bash' && (Object.keys(input).some(key => key !== 'executionId') || typeof input.executionId !== 'string')) throw new Error('停止命令需要对应的 executionId');
                    const data = type === 'bash' ? await worker.shell.start(input) : await worker.shell.abort(input.executionId);
                    safeSend(socket, { type: 'response', id, command: type, success: true, data });
                    return;
                }
                if (['set_steering_mode', 'set_follow_up_mode'].includes(message.type)) {
                    settingsService.loginService.assertIdle();
                    if (settingsService.mutating || nativeService.busy) throw new Error('设置正在保存，请稍后再试');
                    settingsService.mutating = true;
                    try {
                        const { id, type, token, ...input } = message;
                        const data = await worker.setQueueMode(type, input);
                        safeSend(socket, { type: 'response', id, command: type, success: true, data });
                    } finally { settingsService.mutating = false; }
                    return;
                }
                if (!ALLOWED_RPC_COMMANDS.has(message.type)) throw new Error(`Unsupported command: ${message.type}`);

                const { id, type, token, ...payload } = message;
                validateRpcPayload(type, payload);
                const timeout = LONG_RUNNING_COMMANDS.has(type) ? 10 * 60 * 1000 : undefined;
                const completion = type === 'get_messages' && !worker.noSession
                    ? replyNotice({ cwd: worker.cwd, id: worker.sessionId }) : null;
                const data = await worker.request(type, payload, timeout);
                safeSend(socket, { type: 'response', id, command: type, success: true,
                    data: type === 'get_messages' ? { ...data, completion } : data });
            }

            socket.on('close', () => {
                socketClosed = true;
                clearTimeout(authTimer);
                void sideConnection?.dispose();
                void releaseCurrentWorker(false);
            });
            socket.on('error', () => {
                socketClosed = true;
                clearTimeout(authTimer);
                void sideConnection?.dispose();
                void releaseCurrentWorker(false);
            });
        });

        return wss;
    }

    return { mount, attachWebSocket, dispose: async () => {
        sessionSearch.dispose();
        if (!options.accessService) access.dispose();
        await settingsService.loginService.dispose();
        const stoppingDeferred = deferred.dispose();
        const stoppingSide = sideChat.dispose();
        await supervisor.dispose();
        await Promise.all([stoppingDeferred, stoppingSide]);
    }, store, supervisor, deferred, sideChat };
}

module.exports = { createPiAgentGateway };
