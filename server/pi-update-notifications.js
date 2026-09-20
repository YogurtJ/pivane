const { compareVersions } = require('./pi-update-service');
const DAY = 24 * 60 * 60 * 1000;
const invalid = () => Object.assign(new Error('Invalid update notification request'), { status: 400 });

// Instance preferences contain only release metadata and reminder choices, never chat data.
class UpdateNotifications {
    constructor({ preferences, service, idle = () => false, now = Date.now }) {
        Object.assign(this, { preferences, service, idle, now });
        this.pending = null;
    }
    read() { return this.preferences.readDocument().piUpdateNotifications || {}; }
    patch(patch) {
        const document = this.preferences.readDocument();
        this.preferences.writeDocument({ ...document, piUpdateNotifications: { ...document.piUpdateNotifications, ...patch } });
    }
    cachedPi() {
        const state = this.read();
        return compareVersions(state.version, state.version) === 0 && Number.isFinite(state.lastSuccessAt)
            ? { version: state.version, checkedAt: state.lastSuccessAt } : null;
    }
    snapshot() {
        const state = this.read(), enabled = state.enabled !== false;
        const available = enabled && compareVersions(this.service.piVersion, state.version) === -1 && state.ignoredVersion !== state.version;
        const reminding = state.remindVersion === state.version && Number.isFinite(state.remindAt);
        const eligible = Boolean(available && (reminding ? state.remindAt <= this.now() : state.notifiedVersion !== state.version));
        return { enabled, available: Boolean(available), eligible, idle: Boolean(this.idle()),
            currentVersion: this.service.piVersion, version: state.version || null,
            lastSuccessAt: state.lastSuccessAt ?? null, nextCheckAt: state.nextCheckAt ?? null };
    }
    recordSuccess(info) {
        if (!info?.version || compareVersions(info.version, info.version) !== 0) return;
        this.patch({ version: info.version, lastSuccessAt: this.now(), nextCheckAt: this.now() + DAY, failures: 0 });
    }
    check() {
        if (this.pending) return this.pending;
        const state = this.read();
        if (state.enabled === false || state.nextCheckAt > this.now()) return Promise.resolve(this.snapshot());
        // Persist a short reservation before the first await, including across service restarts.
        this.patch({ nextCheckAt: this.now() + 60 * 60 * 1000 });
        this.pending = Promise.resolve().then(async () => {
            try { this.recordSuccess(await this.service.pi()); }
            catch {
                const failures = Math.min(6, (this.read().failures || 0) + 1);
                this.patch({ failures, nextCheckAt: this.now() + Math.min(DAY, 60 * 60 * 1000 * 2 ** (failures - 1)) });
            }
            return this.snapshot();
        }).finally(() => { this.pending = null; });
        return this.pending;
    }
    change(input) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid();
        const keys = Object.keys(input);
        if (keys.length === 1 && keys[0] === 'enabled' && typeof input.enabled === 'boolean') {
            this.patch({ enabled: input.enabled }); return this.snapshot();
        }
        if (keys.length !== 2 || keys.some(key => !['action', 'version'].includes(key))
            || !['claim', 'snooze', 'ignore'].includes(input.action) || typeof input.version !== 'string') throw invalid();
        const snapshot = this.snapshot();
        if (!snapshot.available || input.version !== snapshot.version) throw Object.assign(new Error('Update notification changed'), { status: 409 });
        if (input.action === 'claim') {
            if (!snapshot.eligible || !snapshot.idle) return { ...snapshot, claimed: false };
            this.patch({ notifiedVersion: input.version, remindVersion: null, remindAt: null });
            return { ...this.snapshot(), claimed: true };
        }
        if (input.action === 'snooze') this.patch({ remindVersion: input.version, remindAt: this.now() + 3 * DAY });
        else this.patch({ ignoredVersion: input.version });
        return this.snapshot();
    }
}
module.exports = { UpdateNotifications, DAY };
