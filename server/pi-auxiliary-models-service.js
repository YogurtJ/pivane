const { validateTitleSettings } = require('./workspace-preferences-service');

// Each entry describes an implemented consumer and its existing canonical preference.
// A new purpose needs both a consumer and a validated storage adapter before it is exposed.
const AUXILIARY_PURPOSES = Object.freeze([
    Object.freeze({ id: 'session-title', storage: 'sessionTitles', label: '标题生成', description: '为会话生成简短、易查找的标题',
        automaticLabel: '自动 · 当前线程模型',
        help: '每次最多引用 8,000 字符问答正文，不发送完整会话，也不加入主聊天上下文。',
        enabledLabel: '自动生成会话标题' }),
    Object.freeze({ id: 'media-planner', storage: 'mediaAgent', label: '媒体规划', description: '图像、视频、语音参数与模型接入方案',
        automaticLabel: '自动 · 媒体规划默认',
        help: '自动时按服务器媒体规划配置、Pi 默认模型及可用模型选择。只生成可编辑方案，媒体执行仍需单独确认。' })
]);

class PiAuxiliaryModelsService {
    constructor({ preferences, titles, createModelRuntime }) {
        this.preferences = preferences; this.titles = titles; this.createModelRuntime = createModelRuntime;
        this.busy = false; this.closed = false; this.pending = null;
    }
    snapshot() {
        return { version: 1, revision: this.preferences.getAuxiliaryModelsRevision(), purposes: AUXILIARY_PURPOSES.map(purpose => {
            const { storage, ...descriptor } = purpose;
            return { ...descriptor, settings: storage === 'sessionTitles' ? this.preferences.getSessionTitles() : this.preferences.getMediaAgent() };
        }) };
    }
    save(input) {
        if (this.busy || this.closed) throw Object.assign(new Error('辅助模型设置正在保存或服务正在关闭'), { statusCode: 409 });
        if (!input || typeof input !== 'object' || Array.isArray(input)
            || Object.keys(input).some(key => !['expectedRevision', 'changes'].includes(key))
            || typeof input.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedRevision)
            || !input.changes || typeof input.changes !== 'object' || Array.isArray(input.changes)
            || !Object.keys(input.changes).length) throw new Error('辅助模型设置参数无效');
        const changes = {}, references = [];
        for (const [id, raw] of Object.entries(input.changes)) {
            const purpose = AUXILIARY_PURPOSES.find(item => item.id === id);
            if (!purpose || !raw || typeof raw !== 'object' || Array.isArray(raw)
                || Object.keys(raw).some(key => !['provider', 'modelId', ...(purpose.enabledLabel ? ['enabled'] : [])].includes(key))) throw new Error('辅助模型用途或参数无效');
            const patch = validateTitleSettings(raw);
            changes[purpose.storage] = patch;
            if (patch.provider) references.push({ provider: patch.provider, modelId: patch.modelId });
        }
        if (input.expectedRevision !== this.preferences.getAuxiliaryModelsRevision()) throw Object.assign(new Error('辅助模型设置已变化，请刷新后再保存'), { statusCode: 409 });
        this.busy = true; // Reserve before model/auth lookup, including concurrent browser saves.
        this.pending = (async () => {
            try {
                if (references.length) {
                    let runtime, available;
                    try {
                        runtime = await this.createModelRuntime();
                        available = await runtime.getAvailable(undefined, { signal: AbortSignal.timeout(20000) });
                    } catch { throw new Error('无法验证辅助模型，请检查模型与认证配置'); }
                    for (const reference of references) {
                        const model = available.find(item => item.provider === reference.provider && item.id === reference.modelId);
                        if (!model || !model.input?.includes('text') || /:batch$/.test(model.id)) throw new Error('请选择已接入且可用的文本模型');
                    }
                }
                if (this.closed) throw new Error('服务正在关闭，辅助模型设置未保存');
                // One private write, with a fresh revision check, preserves all other preferences.
                this.preferences.setAuxiliaryModels(changes, input.expectedRevision);
                if (changes.sessionTitles) this.titles.settingsChanged();
                return this.snapshot();
            } finally { this.busy = false; }
        })();
        return this.pending;
    }
    async dispose() { this.closed = true; await Promise.allSettled([this.pending]); }
}
module.exports = { PiAuxiliaryModelsService, AUXILIARY_PURPOSES };
