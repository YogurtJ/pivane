const cancelled = () => Object.assign(new Error('渠道权限、绑定或任务状态已变化，指令未继续执行'), { code: 'CHANNEL_ADMISSION_CHANGED' });

// This is an execution receipt, not another conversation history. The native
// operation remains the source of truth; unknown outcomes are never replayed.
function commandControl(service, job, run = {}) {
    const check = () => {
        if (!service.canAdmit(service.job(job.id))) throw cancelled();
    };
    const submit = () => {
        check();
        if (!service.job(job.id).commandSubmitted) {
            service.updateJob(job.id, { commandSubmitted: true, text: undefined, images: undefined });
        }
    };
    const withWorker = async callback => {
        check();
        const current = service.job(job.id);
        const session = await service.store.getSession(current.target.cwd, current.target.sessionId);
        check();
        const worker = await service.supervisor.getWorker({ cwd: session.cwd, sessionPath: session.path, sessionId: session.id });
        check();
        run.worker = worker;
        if (!worker.isIdle()) throw Object.assign(new Error('会话尚未空闲'), { code: 'SESSION_BUSY' });
        return worker.exclusive(async (rpc, state) => {
            check();
            worker.channelCommandId = job.id;
            const guardedRpc = (type, payload = {}, timeout, prepared) => rpc(type, payload,
                type.startsWith('get_') ? timeout : null, () => {
                    (type.startsWith('get_') ? check : submit)();
                    prepared?.();
                });
            try { return await callback(worker, guardedRpc, state, session); }
            finally { worker.channelCommandId = null; }
        });
    };
    return { check, submit, withWorker };
}

async function executeCommand(service, job, slash, run) {
    if (!service.canAdmit(service.job(job.id))) return;
    service.updateJob(job.id, { status: 'dispatching', kind: 'slash', command: slash.command, commandSubmitted: false });
    let reply;
    try {
        reply = await service.handleSlash(service.job(job.id), slash, run);
    } catch (error) {
        const current = service.job(job.id);
        if (error.code === 'CHANNEL_ADMISSION_CHANGED' && !current?.commandSubmitted) {
            if (current) service.updateJob(job.id, { status: 'cancelled', reason: 'admission-changed', text: undefined, images: undefined });
            return;
        }
        if (error.code === 'SESSION_BUSY' && !current?.commandSubmitted && service.canAdmit(current)) {
            // Nothing was submitted. Keep the original text and queue position.
            service.updateJob(job.id, { status: 'queued', kind: undefined, command: undefined });
            return;
        }
        if (current?.commandSubmitted || error.code === 'RPC_TIMEOUT') throw error;
        reply = `❌ 指令未执行：${error.status ? error.message : '无法读取目标状态，请稍后重试。'}`;
    }
    if (!service.canAdmit(service.job(job.id))) {
        service.updateJob(job.id, { status: 'cancelled', reason: 'delivery-revoked', text: undefined, images: undefined });
        return;
    }
    service.updateJob(job.id, { status: 'ready', directReply: reply || '', text: undefined, images: undefined, waiting: false });
}

module.exports = { commandControl, executeCommand };
