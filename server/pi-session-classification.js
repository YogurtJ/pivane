const { getSdk } = require('./pi-session-store');
const { readProfileBinding } = require('./pi-profile-state');
const { readProjectAssignment, PROJECT_CHANGE_ENTRY, UUID } = require('./pi-assistant-project-state');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };

class PiSessionClassification {
    constructor({ store, supervisor, profiles, projects, sideChat }) { Object.assign(this, { store, supervisor, profiles, projects, sideChat }); }

    async inspect(cwd, id) {
        const session = await this.store.getSession(cwd, id);
        if (!session.agentProfile?.available || session.assistant || session.profileAuthoring) fail('此会话不支持更改助手分类');
        const { SessionManager } = await getSdk();
        const manager = this.store.profileManager(session, SessionManager);
        const assignment = readProjectAssignment(manager);
        if (!assignment.valid) fail('会话分类记录存在冲突，请先核对原始归属', 409);
        const listed = await this.projects.list(session.agentProfile.id);
        return { session, projectId: assignment.projectId, revision: assignment.revision, projectsRevision: listed.revision,
            projects: listed.projects.filter(project => project.cwd === session.cwd && !project.archived) };
    }

    async change(cwd, id, input) {
        if (!input || Object.keys(input).some(key => !['cwd', 'projectId', 'expectedRevision', 'expectedProjectsRevision'].includes(key))
            || !(input.projectId === null || typeof input.projectId === 'string' && UUID.test(input.projectId))
            || !(input.expectedRevision === null || typeof input.expectedRevision === 'string' && input.expectedRevision)
            || typeof input.expectedProjectsRevision !== 'string') fail('分类变更参数无效');
        return this.profiles.reserve(async () => {
            const original = await this.store.getSession(cwd, id);
            let stopped = false;
            try {
                const result = await this.supervisor.withSessionEdit(original.path, async worker => {
                    if (worker && [...this.sideChat?.parents.values() || []].some(parent => parent.source?.cwd === original.cwd
                        && parent.source?.sessionId === original.id && (parent.preparing || parent.ticket || parent.connection)))
                        throw Object.assign(new Error('请关闭此会话的侧聊后再更改分类'), { status: 409, code: 'SESSION_BUSY' });
                    const current = await this.inspect(cwd, id);
                    if (current.session.path !== original.path || current.revision !== input.expectedRevision
                        || current.projectsRevision !== input.expectedProjectsRevision) fail('分类已变化，请重新打开后核对', 409);
                    if (input.projectId !== null && !current.projects.some(project => project.id === input.projectId))
                        fail('目标分类不可用，请选择同一助手、同一目录下的未归档分类');
                    if (input.projectId === current.projectId) return { session: current.session, changed: false };
                    if (worker) { stopped = true; await this.supervisor.stopSession(original.path); }
                    // Re-read after shutdown; append through the native manager only.
                    const session = await this.store.getSession(cwd, id);
                    const { SessionManager } = await getSdk();
                    const manager = this.store.profileManager(session, SessionManager);
                    const state = readProjectAssignment(manager);
                    if (!state.valid || state.revision !== current.revision
                        || readProfileBinding(manager)?.profileId !== current.session.agentProfile.id) fail('会话归属已变化，请重新核对', 409);
                    manager.appendCustomEntry(PROJECT_CHANGE_ENTRY, { version: 1, sessionId: session.id, cwd: session.cwd,
                        previousRevision: state.revision, previousProjectId: state.projectId, projectId: input.projectId });
                    require('./pi-private-files').privateFileMode(session.path);
                    this.store.sessionLists.delete(session.cwd);
                    const saved = readProjectAssignment(manager);
                    if (!saved.valid || saved.projectId !== input.projectId) fail('分类保存结果需要核对', 503);
                    const project = current.projects.find(project => project.id === input.projectId);
                    return { session: { ...session, assistantProject: project ? { id: project.id, name: project.name, cwd: project.cwd, available: true } : null }, changed: true };
                });
                if (result.changed) this.supervisor.emit('sessionClassification', result.session);
                return result;
            } catch (error) {
                if (stopped) this.supervisor.emit('sessionClassification', original);
                if (error.code === 'SESSION_BUSY') error.status = 409;
                throw error;
            }
        });
    }
}

function mountSessionClassification(router, options) {
    const service = new PiSessionClassification(options);
    const endpoint = action => async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try { res.json(await action(req)); }
        catch (error) { res.status(error.status || 400).json({ error: error.message, code: error.code }); }
    };
    router.get('/sessions/:id/classification', endpoint(req => service.inspect(req.query.cwd, req.params.id)));
    router.put('/sessions/:id/classification', endpoint(req => service.change(req.body?.cwd, req.params.id, req.body)));
    return service;
}

module.exports = { PiSessionClassification, mountSessionClassification };
