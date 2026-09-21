const { randomUUID } = require('node:crypto');
const { isInternalCommand, privateReply } = require('./pivane-compat');
class PiModelCatalog {
    constructor(worker) { this.worker = worker; this.pending = new Map(); this.inflight = null; }
    refresh() {
        if (this.inflight) return this.inflight;
        const task = this.run().then(data => { this.worker._broadcast({ type: 'gateway_models', models: data.models }); return data; }); this.inflight = task;
        task.finally(() => { if (this.inflight === task) this.inflight = null; }).catch(() => {});
        return task;
    }
    handle(result) {
        result = privateReply(result);
        if (typeof result?.pivaneModels !== 'string') return false;
        if (this.pending.has(result.pivaneModels)) this.pending.set(result.pivaneModels, result);
        return true; // Private, including late/unknown responses.
    }
    async run() {
        const worker = this.worker;
        if (worker.modelChangesPending || worker.modelChangeUncertain) throw Object.assign(new Error('模型切换尚未确认，请等待完成；超时后请空闲退出并重开线程'), { code: 'SESSION_BUSY' });
        return worker.exclusive(async () => {
            const commands = await worker.client.request('get_commands');
            const command = commands.commands?.find(c => isInternalCommand(c.name) && c.description?.includes('model-catalog-v1'));
            if (!command) throw new Error('当前运行实例尚未支持模型目录刷新，请空闲退出并重新打开线程');
            const id = randomUUID(); this.pending.set(id, null);
            try {
                await worker.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'models', id, token: worker.navigationToken })}` }, 12000);
                const result = this.pending.get(id);
                if (!result) throw Object.assign(new Error('模型目录刷新结果未确认，请重新连接线程'), { code: 'MODEL_REFRESH_UNKNOWN' });
                if (!result.success) throw new Error('模型目录刷新未完成，请稍后点击刷新；当前模型未切换');
                return result.data;
            } catch (error) {
                if (error.code === 'MODEL_REFRESH_UNKNOWN' || /timed out|exited|closed|EPIPE/i.test(error.message)) {
                    worker._broadcast({ type: 'gateway_reconnect' });
                    await worker.dispose(); // Started idle under exclusivity; never unlock an uncertain refresh.
                }
                throw error;
            } finally { this.pending.delete(id); }
        });
    }
}
module.exports = { PiModelCatalog };
