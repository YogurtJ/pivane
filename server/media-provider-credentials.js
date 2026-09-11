// Media API credentials use Pi's public lifecycle API and its native credential store.
// The private runtime registers no chat models. Keys are escaped literals in Pi's config-value syntax.
class MediaProviderCredentials {
    constructor(options = {}) { this.options = options; this.registered = new Set(); }
    providerId(id) { return `pi5-media:${id}`; }
    async runtime() {
        if (process.platform === 'win32' && this.options.authPath) require('./pi-private-files').privateDirectory(require('node:path').dirname(this.options.authPath));
        if (!this.runtimePromise) this.runtimePromise = require('./pi-session-store').getSdk().then(({ ModelRuntime }) => ModelRuntime.create({
            modelsPath: null, authPath: this.options.authPath, refreshOnCreate: false, allowModelNetwork: false, signal: AbortSignal.timeout(30000)
        })).catch(() => { this.runtimePromise = null; throw new Error('Pi media credential service could not initialize'); });
        return this.runtimePromise;
    }
    async register(id) {
        const runtime = await this.runtime();
        const providerId = this.providerId(id);
        if (!this.registered.has(providerId)) {
            const unavailable = () => { throw new Error('Media credentials do not expose a chat model'); };
            runtime.registerNativeProvider({ id: providerId, name: 'Media service', getModels: () => [], stream: unavailable, streamSimple: unavailable,
                auth: { apiKey: { name: 'Media API Key',
                    login: async interaction => ({ type: 'api_key', key: await interaction.prompt({ type: 'secret', message: 'API Key' }) }),
                    check: async ({ credential }) => credential?.key ? { type: 'api_key', source: 'stored' } : undefined,
                    resolve: async ({ credential }) => credential?.key ? { auth: { apiKey: credential.key }, source: 'stored' } : undefined
                } }
            });
            this.registered.add(providerId);
        }
        return runtime;
    }
    async list() {
        const runtime = await this.runtime();
        try { return new Set((await runtime.listCredentials({ signal: AbortSignal.timeout(10000) })).filter(item => item.type === 'api_key' && item.providerId.startsWith('pi5-media:')).map(item => item.providerId.slice('pi5-media:'.length))); }
        catch { throw new Error('Media credential status could not be read'); }
    }
    async get(id) {
        const runtime = await this.register(id);
        try {
            const result = await runtime.getAuth(this.providerId(id), { signal: AbortSignal.timeout(10000) });
            return result?.auth?.apiKey || '';
        } catch { throw new Error('Media credential could not be read'); }
    }
    async save(id, key) {
        const runtime = await this.register(id);
        const literal = key.replace(/\$/g, '$$$$').replace(/^!/, '$!');
        try {
            await runtime.login(this.providerId(id), 'api_key', { signal: AbortSignal.timeout(30000), prompt: async () => literal, notify: () => {} });
        } catch (error) {
            // A committed credential must not be blindly retried after snapshot synchronization fails.
            if (error.name !== 'CredentialSynchronizationError' || await this.get(id) !== key) throw new Error('Media credential could not be saved; refresh its status before trying again');
        }
    }
    async remove(id) {
        const runtime = await this.register(id);
        try { await runtime.logout(this.providerId(id), { signal: AbortSignal.timeout(30000) }); }
        catch (error) {
            if (error.name !== 'CredentialSynchronizationError' || (await this.list()).has(id)) throw new Error('Media credential could not be removed; refresh its status before trying again');
        }
    }
}
module.exports = { MediaProviderCredentials };
