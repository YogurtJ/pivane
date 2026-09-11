const { randomUUID } = require('node:crypto');

function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function literal(value) { return value.replace(/\$/g, '$$$$').replace(/^!/, '$!'); }
function safeUrl(value) {
    try {
        const url = new URL(value);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        if ([...url.searchParams.keys()].some(key => /^(access_token|refresh_token|api_key|token)$/i.test(key))) return null;
        return url.href;
    } catch { return null; }
}

// One provider-owned login at a time: native OAuth flows may bind the same loopback port.
// Handles are private to the initiating page; credentials and submitted answers are never in snapshots.
class PiProviderLoginService {
    constructor(createRuntime, options = {}) {
        this.createRuntime = createRuntime;
        this.timeoutMs = options.timeoutMs || 10 * 60 * 1000;
        this.flow = null;
        this.closed = false;
    }
    get busy() { return Boolean(this.flow && !this.flow.finished); }
    assertIdle() { if (this.busy) throw fail('请先完成或取消当前供应商登录', 409); }
    async start(providerId, method) {
        this.assertIdle();
        if (this.closed) throw fail('登录服务已关闭', 503);
        if (typeof providerId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(providerId)) throw fail('Invalid provider ID');
        if (!['api_key', 'oauth'].includes(method)) throw fail('Unsupported login method');
        const flow = { id: randomUUID(), providerId, method, revision: 0, status: 'starting', events: [], prompts: new Map(),
            controller: new AbortController(), expiresAt: Date.now() + this.timeoutMs, finished: false, answers: [] };
        this.flow = flow;
        flow.timer = setTimeout(() => this.cancel(flow.id, 'expired'), this.timeoutMs);
        flow.timer.unref?.();
        flow.task = this.run(flow);
        return this.snapshot(flow.id);
    }
    async run(flow) {
        try {
            const runtime = await this.createRuntime();
            flow.controller.signal.throwIfAborted();
            const provider = runtime.getProvider(flow.providerId);
            if (!(flow.method === 'oauth' ? provider?.auth?.oauth?.login : provider?.auth?.apiKey?.login)) throw fail('Unsupported login method');
            flow.status = 'waiting'; flow.revision++;
            await runtime.login(flow.providerId, flow.method, {
                signal: flow.controller.signal,
                prompt: prompt => this.prompt(flow, prompt),
                notify: event => this.notify(flow, event)
            });
            // Cancellation can race a credential commit. Successful native completion is authoritative.
            flow.status = 'success';
        } catch (error) {
            if (error.name === 'CredentialSynchronizationError') {
                flow.status = 'committed';
                flow.message = '凭据已保存，但模型状态同步失败。请刷新供应商状态，不要重复登录。';
            } else if (flow.controller.signal.aborted) {
                flow.status = flow.cancelReason === 'expired' ? 'expired' : 'cancelled';
            } else {
                flow.status = 'error';
                flow.message = 'Pi 登录未完成。请检查授权页面及供应商配置；核对凭据状态后可重新发起。';
            }
        } finally {
            clearTimeout(flow.timer);
            for (const pending of [...flow.prompts.values()]) pending.cancel();
            flow.answers = []; flow.events = []; flow.finished = true; flow.revision++;
        }
    }
    redact(flow, value) {
        let text = String(value || '').slice(0, 8000);
        for (const answer of flow.answers) if (answer) text = text.split(answer).join('[已隐藏]');
        return text;
    }
    notify(flow, event) {
        if (flow.controller.signal.aborted || flow.finished) return;
        let clean;
        if (event.type === 'auth_url' && safeUrl(event.url)) clean = { type: event.type, url: safeUrl(event.url), instructions: this.redact(flow, event.instructions) };
        if (event.type === 'device_code' && safeUrl(event.verificationUri)) clean = { type: event.type, userCode: String(event.userCode).slice(0, 200), verificationUri: safeUrl(event.verificationUri), expiresInSeconds: event.expiresInSeconds };
        if (['progress', 'info'].includes(event.type)) clean = { type: event.type, message: this.redact(flow, event.message),
            links: (event.links || []).slice(0, 8).filter(link => safeUrl(link.url)).map(link => ({ url: safeUrl(link.url), label: this.redact(flow, link.label) })) };
        if (!clean) return;
        if (clean.type === 'progress') flow.events = flow.events.filter(item => item.type !== 'progress');
        flow.events.push(clean); flow.events = flow.events.slice(-20); flow.revision++;
    }
    prompt(flow, prompt) {
        if (flow.prompts.size >= 8 || !['text', 'secret', 'select', 'manual_code'].includes(prompt.type)) return Promise.reject(fail('Unsupported authentication prompt'));
        const signal = prompt.signal ? AbortSignal.any([prompt.signal, flow.controller.signal]) : flow.controller.signal;
        if (signal.aborted) return Promise.reject(signal.reason);
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const finish = (value, error) => {
                signal.removeEventListener('abort', cancel);
                if (!flow.prompts.delete(id)) return;
                flow.revision++;
                if (error) reject(error); else resolve(value);
            };
            const cancel = () => finish(undefined, new Error('Authentication prompt cancelled'));
            flow.prompts.set(id, { id, type: prompt.type, message: this.redact(flow, prompt.message),
                options: prompt.type === 'select' ? prompt.options.slice(0, 100).map(option => ({ id: String(option.id), label: this.redact(flow, option.label), description: this.redact(flow, option.description) })) : undefined,
                finish, cancel });
            signal.addEventListener('abort', cancel, { once: true }); flow.revision++;
        });
    }
    get(id) {
        if (!this.flow || this.flow.id !== id) throw fail('登录已失效，请重新发起', 404);
        return this.flow;
    }
    snapshot(id) {
        const flow = this.get(id);
        return { id: flow.id, providerId: flow.providerId, method: flow.method, revision: flow.revision, status: flow.status,
            expiresAt: flow.expiresAt, finished: flow.finished, message: flow.message || '',
            events: flow.events.map(event => ({ ...event,
                ...(event.message !== undefined ? { message: this.redact(flow, event.message) } : {}),
                ...(event.instructions !== undefined ? { instructions: this.redact(flow, event.instructions) } : {}) })),
            prompts: [...flow.prompts.values()].map(({ id, type, message, options }) => ({ id, type, message: this.redact(flow, message), options })) };
    }
    answer(id, input) {
        const flow = this.get(id);
        const pending = flow.prompts.get(input?.promptId);
        if (flow.finished || flow.controller.signal.aborted || !pending) throw fail('此登录步骤已失效，请等待最新状态', 409);
        const value = input.value;
        if (typeof value !== 'string' || value.length > 32768 || value.includes('\u0000')) throw fail('Invalid login answer');
        if (pending.type === 'select' && !pending.options.some(option => option.id === value)) throw fail('Invalid login selection');
        if (flow.answers.length >= 64 || flow.answers.reduce((total, answer) => total + answer.length, value.length) > 128 * 1024) throw fail('登录输入超过限额，请取消后重新发起');
        flow.answers.push(value);
        // API-key flows store config-value strings. Web entries are literals, never shell/env expressions.
        pending.finish(flow.method === 'api_key' && pending.type !== 'select' ? literal(value) : value);
        return this.snapshot(id);
    }
    cancel(id, reason = 'cancelled') {
        const flow = this.get(id);
        if (!flow.finished) { flow.cancelReason = reason; flow.status = 'cancelling'; flow.revision++; flow.controller.abort(new Error('Login cancelled')); }
        return this.snapshot(id);
    }
    async dispose() { this.closed = true; if (this.busy) this.cancel(this.flow.id); await this.flow?.task; }
}
module.exports = { PiProviderLoginService, literal, safeUrl };
