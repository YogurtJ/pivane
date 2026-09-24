const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { getSdk } = require('../pi-session-store');
const { safeFile } = require('../pi-native-service');
const { readSafe } = require('../pi-maintenance-files');
const { profileMemoryCapability } = require('./management');
const { reviewModelConfig } = require('./auto-learn');

// Instance-owned executable configuration. Never register the upstream default
// extension globally: only the verified profile worker receives these values.
class ProfileMemoryConfiguration {
    constructor({ getAgentDir = async () => (await getSdk()).getAgentDir() } = {}) {
        this.getAgentDir = getAgentDir;
        this.cached = null;
    }

    async snapshot() {
        const unavailable = { bundlePath: null, reviewModel: null, capability: { installed: false, autoLearn: false } };
        try {
            const agentDir = await this.getAgentDir();
            const file = safeFile(agentDir, ['pivane-profiles', 'runtime.json']);
            let bytes;
            try { bytes = readSafe(file, 16384); }
            catch (error) { if (error.code === 'ENOENT') { this.cached = null; return unavailable; } throw error; }
            const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
            if (!data || data.version !== 1 || typeof data.bundlePath !== 'string'
                || !path.isAbsolute(data.bundlePath) || data.bundlePath.length > 4096
                || Object.keys(data).some(key => !['version', 'bundlePath', 'reviewModel'].includes(key))) throw new Error('Invalid memory runtime configuration');
            const reviewModel = data.reviewModel == null ? null : reviewModelConfig(JSON.stringify(data.reviewModel));
            if (data.reviewModel != null && !reviewModel) throw new Error('Invalid memory review model');
            const stat = fs.lstatSync(data.bundlePath, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync.native(data.bundlePath) !== data.bundlePath) throw new Error('Invalid memory bundle');
            const key = createHash('sha256').update(bytes).update([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')).digest('hex');
            if (this.cached?.key === key && Date.now() - this.cached.at < 5000) return this.cached.value;
            const capability = { ...profileMemoryCapability({ bundlePath: data.bundlePath }), autoLearn: false };
            const value = { bundlePath: capability.installed ? data.bundlePath : null, reviewModel, capability };
            this.cached = { key, at: Date.now(), value };
            return value;
        } catch {
            this.cached = null;
            return unavailable;
        }
    }

    async environment(context) {
        const cleared = { PIVANE_HERMES_BUNDLE: undefined, PIVANE_PROFILE_MEMORY_REVIEW_MODEL: undefined };
        if (!context || !context.memory.enabled && !context.skills.learnedEnabled) return cleared;
        const current = await this.snapshot();
        return { ...cleared,
            PIVANE_HERMES_BUNDLE: current.capability.installed ? current.bundlePath : undefined,
            PIVANE_PROFILE_MEMORY_REVIEW_MODEL: undefined };
    }
}

module.exports = { ProfileMemoryConfiguration };
