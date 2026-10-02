const { randomUUID } = require('node:crypto');
const { isInternalCommand, privateReply } = require('./pivane-compat');
const { validateSpeed, LEVELS } = require('./pi-model-speed');
class PiModelSpeedControl {
    constructor(worker) { this.worker = worker; this.value = null; this.pending = new Map(); }
    handle(raw) {
        const result = privateReply(raw);
        if (typeof result?.pivaneSpeedReply === 'string') {
            if (this.pending.has(result.pivaneSpeedReply)) this.pending.set(result.pivaneSpeedReply, result);
            return true;
        }
        if (!result || !Object.hasOwn(result, 'pivaneSpeedState')) return false;
        const state = result.pivaneSpeedState;
        try {
            if (!state || typeof state.runtimeId !== 'string' || state.runtimeId.length > 100 || !Number.isSafeInteger(state.revision) || state.revision < 0
                || !Array.isArray(state.levels) || state.levels.some(level => !LEVELS.includes(level)) || !LEVELS.includes(state.level)
                || state.provider !== null && (typeof state.provider !== 'string' || state.provider.length > 500)
                || state.modelId !== null && (typeof state.modelId !== 'string' || state.modelId.length > 500)) return true;
            validateSpeed({ modes: state.modes, defaultLevel: state.defaultLevel });
            if (this.value?.runtimeId === state.runtimeId && this.value.revision > state.revision) return true;
            this.value = structuredClone(Object.fromEntries(['runtimeId', 'revision', 'provider', 'modelId', 'level', 'levels', 'modes', 'defaultLevel'].map(key => [key, state[key]])));
            this.worker._broadcast({ type: 'gateway_model_speed', speed: this.value });
        } catch { /* Malformed and foreign private records never become notices. */ }
        return true;
    }
    async set(input) {
        if (this.worker.modelChangesPending || this.worker.modelChangeUncertain) throw new Error('请等待模型切换确认后再选择速度');
        return this.worker.exclusive(async () => {
            const worker = this.worker;
            const commands = await worker.client.request('get_commands');
            const command = commands.commands?.find(c => isInternalCommand(c.name) && c.description?.includes('speed-v1'));
            if (!command) throw new Error('当前运行实例尚未支持速度设置，请空闲退出并重新打开线程');
            const id = randomUUID(); this.pending.set(id, null);
            try {
                await worker.client.request('prompt', { message: `/${command.name} ${JSON.stringify({ mode: 'speed', id, token: worker.navigationToken, input })}` }, 12000);
                const result = this.pending.get(id);
                if (!result) throw Object.assign(new Error('速度设置未收到确认，请重新连接后核对'), { code: 'MODEL_SPEED_UNKNOWN' });
                if (!result.success) throw new Error(result.error || '速度设置失败');
                if (!this.value || this.value.runtimeId !== result.data?.runtimeId || this.value.revision !== result.data?.revision)
                    throw Object.assign(new Error('速度状态尚未确认，请重新连接核对'), { code: 'MODEL_SPEED_UNKNOWN' });
                return structuredClone(this.value);
            } catch (error) {
                if (error.code === 'RPC_TIMEOUT' || error.code === 'MODEL_SPEED_UNKNOWN' || /exited|closed|EPIPE/i.test(error.message)) {
                    worker._broadcast({ type: 'gateway_reconnect' });
                    await worker.dispose();
                }
                throw error;
            } finally { this.pending.delete(id); }
        });
    }
}
module.exports = { PiModelSpeedControl };
