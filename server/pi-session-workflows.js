const { customTypeIs } = require('./pivane-compat');
const { promptFromEntry, replyText, isReplyForkPoint, validateMessage, assertSendable } = require('./pi-message-payload');

function workflowSnapshot(snapshot) {
    const byId = new Map(snapshot.entries.map(entry => [entry.id, entry]));
    // Resolve each ancestry edge once, independently of serialization order.
    // Validate the whole path even when a nearer user message was found.
    const nearest = new Map([[null, null]]);
    const lastUserAt = target => {
        let id = target || null;
        const path = [], visiting = new Set();
        while (!nearest.has(id)) {
            if (visiting.has(id) || !byId.has(id)) throw new Error('会话分支无效');
            visiting.add(id);
            const entry = byId.get(id); path.push(entry); id = entry.parentId || null;
        }
        let user = nearest.get(id);
        for (let i = path.length - 1; i >= 0; i--) {
            const entry = path[i];
            if (entry.type === 'message' && entry.message?.role === 'user') user = entry;
            nearest.set(entry.id, user);
        }
        return nearest.get(target || null);
    };
    const lastUser = lastUserAt(snapshot.leafId);
    const users = snapshot.entries.filter(entry => entry.type === 'message' && entry.message?.role === 'user');
    const previews = new Map(users.map(entry => [entry.id, promptFromEntry(entry).message.slice(0, 180)]));
    const versions = [];
    const seen = new Set();
    for (const entry of snapshot.entries) {
        if (entry.type !== 'custom' || !customTypeIs(entry, 'pivane-web-navigation')) continue;
        const target = entry.data?.fromLeafId;
        // Native forks copy one branch, including its navigation markers. An old
        // leaf on a discarded sibling is provenance, not a restorable local version.
        if (!target || !byId.has(target) || seen.has(target) || target === snapshot.leafId) continue;
        seen.add(target);
        const user = lastUserAt(target);
        versions.push({ entryId: target, timestamp: entry.timestamp, text: user ? previews.get(user.id) : '空上下文' });
    }
    return {
        leafId: snapshot.leafId,
        lastUserId: lastUser?.id || null,
        prompts: users.map(entry => ({ entryId: entry.id, timestamp: entry.message.timestamp, text: previews.get(entry.id) })),
        replies: snapshot.entries.filter(isReplyForkPoint).map(entry => ({ entryId: entry.id, timestamp: entry.message.timestamp, text: replyText(entry.message).slice(0, 180) })),
        versions: versions.reverse()
    };
}

function mountSessionWorkflows(router, { store, supervisor, deferred, preferences }) {
    const forks = new (require('./pi-session-fork-requests').ForkRequests)(store);
    const sessionWorker = async (cwd, id) => {
        const session = await store.getSession(cwd, id);
        const worker = await supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
        return { session, worker };
    };
    const endpoint = handler => async (req, res) => {
        try { res.set('Cache-Control', 'no-store'); await handler(req, res); }
        catch (error) { res.status(error.status || (error.code === 'SESSION_BUSY' ? 409 : 400)).json({ error: error.message, code: error.code }); }
    };
    const validateLeaf = (snapshot, expected) => {
        if (expected === undefined || expected !== snapshot.leafId) throw new Error('会话已变化，请重新打开操作面板');
    };

    router.get('/sessions/:id/workflow', endpoint(async (req, res) => {
        const { worker } = await sessionWorker(req.query.cwd, req.params.id);
        const snapshot = await worker.request('get_entries');
        res.json(workflowSnapshot(snapshot));
    }));
    router.get('/sessions/:id/prompt/:entryId', endpoint(async (req, res) => {
        const { worker } = await sessionWorker(req.query.cwd, req.params.id);
        const snapshot = await worker.request('get_entries');
        res.json({ ...promptFromEntry(snapshot.entries.find(entry => entry.id === req.params.entryId)), leafId: snapshot.leafId });
    }));
    router.get('/sessions/:id/forks/:requestId', endpoint(async (req, res) => {
        const session = await store.getSession(req.query.cwd, req.params.id);
        res.json(await forks.status(session, req.params.requestId));
    }));
    router.post('/sessions/:id/fork', endpoint(async (req, res) => {
        const session = await store.getSession(req.body.cwd, req.params.id);
        const create = async start => {
            const worker = await supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
            return worker.exclusive(async rpc => {
                await store.getSession(session.cwd, session.id);
                const snapshot = await rpc('get_entries');
                validateLeaf(snapshot, req.body.expectedLeafId);
                if (req.body.entryId !== undefined && typeof req.body.entryId !== 'string') throw new Error('分叉位置无效');
                start();
                return store.forkSession(session, snapshot, req.body.entryId, req.body.position);
            });
        };
        const result = req.body.requestId === undefined ? await create(() => {}) : await forks.run(session, req.body, create);
        res.status(201).json(result);
    }));
    router.post('/sessions/:id/retry', endpoint(async (req, res) => {
        const payload = validateMessage(req.body, { plain: true });
        const { session, worker } = await sessionWorker(req.body.cwd, req.params.id);
        await worker.exclusive(async (rpc, runtime) => {
            await store.getSession(session.cwd, session.id);
            assertSendable(runtime, payload);
            const snapshot = await rpc('get_entries');
            validateLeaf(snapshot, req.body.expectedLeafId);
            if (workflowSnapshot(snapshot).lastUserId !== req.body.entryId) throw new Error('只能编辑最近一条问题');
            deferred.pauseSession(session.cwd, session.id);
            await worker.navigate(rpc, { mode: 'retry', entryId: req.body.entryId, expectedLeafId: snapshot.leafId });
            worker._broadcast({ type: 'gateway_context_changed', messages: (await rpc('get_messages')).messages });
            preferences.clearReplyNotice(session.cwd, session.id);
            await rpc('prompt', payload, 60000);
        });
        res.json({ accepted: true });
    }));
    router.post('/sessions/:id/restore', endpoint(async (req, res) => {
        const { session, worker } = await sessionWorker(req.body.cwd, req.params.id);
        await worker.exclusive(async rpc => {
            await store.getSession(session.cwd, session.id);
            const snapshot = await rpc('get_entries');
            validateLeaf(snapshot, req.body.expectedLeafId);
            if (!workflowSnapshot(snapshot).versions.some(version => version.entryId === req.body.entryId)) throw new Error('历史版本不存在');
            deferred.pauseSession(session.cwd, session.id);
            await worker.navigate(rpc, { mode: 'restore', entryId: req.body.entryId, expectedLeafId: snapshot.leafId });
            preferences.clearReplyNotice(session.cwd, session.id);
            worker._broadcast({ type: 'gateway_context_changed', messages: (await rpc('get_messages')).messages });
        });
        res.json({ restored: true });
    }));
    router.get('/sessions/:id/deferred', endpoint(async (req, res) => {
        const session = await store.getSession(req.query.cwd, req.params.id);
        const jobs = deferred.list(session.cwd, session.id, { detail: req.query.detail === 'true' });
        res.json({ revision: deferred.revision, jobs });
    }));
    router.post('/sessions/:id/deferred', endpoint(async (req, res) => {
        const session = await store.getSession(req.body.cwd, req.params.id);
        if (supervisor.getActiveWorker(session.path)?.operation) throw new Error('会话操作进行中，请稍后再预约');
        res.status(201).json(deferred.create(session, req.body));
    }));
    router.patch('/sessions/:id/deferred/:jobId', endpoint(async (req, res) => {
        const session = await store.getSession(req.body.cwd, req.params.id);
        if (supervisor.getActiveWorker(session.path)?.operation) throw new Error('会话操作进行中，请稍后再修改');
        res.json(deferred.update(session.cwd, session.id, req.params.jobId, req.body));
    }));
}

module.exports = { mountSessionWorkflows, workflowSnapshot };
