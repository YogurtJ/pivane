const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const privateFiles = require('./pi-private-files');

// In-chat media requests: a validated plan shown as a chat card, executed only
// when the user confirms that card. The plan id correlates the card with its
// attempts so a refresh, another tab or the phone sees the same state instead
// of offering a second paid submission. Generation itself is the lab's
// review/execute ticket; this journal never retries or replays a request.

const KEY = /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEYS = 2000;
const MAX_ATTEMPTS = 20;
const ASSET_URL = /^\/(images|videos|audio)\/[^/?#\\]+$/;
const fail = (message, statusCode = 400, extra = {}) => { throw Object.assign(new Error(message), { statusCode }, extra); };

function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value ?? null);
}

function assetOf(kind, response) {
    const result = response?.result || {};
    const item = result.asset || result.image || result.video || result.historyItem || (Array.isArray(result.images) ? result.images[0] : null) || result;
    const url = item?.url || item?.imageUrl || item?.videoUrl || item?.audioUrl || result.audioUrl;
    if (typeof url !== 'string' || !ASSET_URL.test(url.split('?')[0])) return null;
    return { url, kind, id: item?.id == null ? null : String(item.id).slice(0, 120), mimeType: typeof item?.mimeType === 'string' ? item.mimeType.slice(0, 80) : null };
}

class MediaChatRequests {
    constructor({ lab, file, now = Date.now }) {
        Object.assign(this, { lab, file, now });
        this.pending = new Set();
        try { this.entries = this.load(); }
        catch (error) {
            // Keep the server usable; refuse new submissions rather than overwrite unreadable records.
            this.entries = new Map(); this.unavailable = error.message;
        }
    }

    load() {
        let items = [];
        try {
            items = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (!Array.isArray(items)) throw new Error('invalid');
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('In-chat media request records cannot be read; existing data was not changed');
        }
        const entries = new Map();
        let interrupted = false;
        for (const entry of items) {
            if (!entry || !KEY.test(entry.key) || !Array.isArray(entry.attempts)) continue;
            for (const attempt of entry.attempts) if (attempt.status === 'running') {
                // The process stopped while a paid request was in flight: its outcome is unknown.
                Object.assign(attempt, { status: 'uncertain', error: 'Pivane restarted while this request was running; check the gallery before generating again', finishedAt: new Date(this.now()).toISOString() });
                delete attempt.ticket; interrupted = true;
            }
            entries.set(entry.key, entry);
        }
        if (interrupted) this.save(entries);
        return entries;
    }

    save(entries = this.entries) {
        const items = [...entries.values()].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-MAX_KEYS);
        if (items.length < entries.size) for (const key of [...entries.keys()]) if (!items.some(item => item.key === key)) entries.delete(key);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            privateFiles.writePrivateFileSync(temporary, JSON.stringify(items.map(({ key, updatedAt, attempts }) => ({
                key, updatedAt, attempts: attempts.map(({ ticket, ...stored }) => stored) })), null, 1));
            fs.renameSync(temporary, this.file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }

    publicState(key) {
        const entry = this.entries.get(key);
        if (!entry) return { key, attempts: [] };
        return { key, attempts: entry.attempts.map(({ ticket, ...attempt }) => {
            if (attempt.status !== 'running' || !ticket) return attempt;
            try { return { ...attempt, progress: this.lab.executionStatus(ticket).progress || null }; }
            catch { return attempt; }
        }) };
    }

    status(keys) {
        if (!Array.isArray(keys) || keys.length > 100 || keys.some(key => !KEY.test(key))) fail('Provide up to 100 media plan ids');
        return { requests: Object.fromEntries([...new Set(keys)].map(key => [key, this.publicState(key)])) };
    }

    async run(input = {}) {
        const { key, modelId, parameters, confirmed, again } = input;
        if (!KEY.test(key || '')) fail('Unknown media plan id');
        if (confirmed !== true) fail('Generation requires an explicit confirmation');
        if (typeof modelId !== 'string' || !parameters || typeof parameters !== 'object' || Array.isArray(parameters)) fail('A model and parameters are required');
        if (Object.keys(input).some(name => !['key', 'modelId', 'parameters', 'confirmed', 'again'].includes(name))) fail('Unsupported request field');
        if (this.unavailable) fail(this.unavailable, 503);
        if (this.pending.has(key)) fail('This card is already being submitted', 409);
        const previous = this.entries.get(key)?.attempts.at(-1);
        if (previous?.status === 'running') fail('This request is already running', 409, { state: this.publicState(key) });
        // Another tab or a double click must not create a second paid request.
        if (previous && again !== true) fail('This card was already submitted; choose to generate again explicitly', 409, { state: this.publicState(key) });
        if ((this.entries.get(key)?.attempts.length || 0) >= MAX_ATTEMPTS) fail('Too many generations from one card; ask the Agent for a new request', 429);
        this.pending.add(key);
        try {
            const review = await this.lab.review({ modelId, parameters });
            if (!review.model.executable) fail('Media backend is not configured for execution', 503);
            // Run exactly what the card shows: normalized values go back for another confirmation.
            if (stable(review.parameters) !== stable(parameters)) return { status: 'changed', parameters: review.parameters, warnings: review.warnings, state: this.publicState(key) };
            const attempt = { id: randomUUID(), status: 'running', modelId: review.model.id, modelName: review.model.name, kind: review.model.kind,
                // Attachments stay in the gallery history, not in this small journal.
                parameters: Buffer.byteLength(JSON.stringify(review.parameters)) <= 64 * 1024 ? review.parameters : null, startedAt: new Date(this.now()).toISOString(), ticket: review.ticket };
            const entry = this.entries.get(key) || { key, attempts: [] };
            entry.attempts.push(attempt); entry.updatedAt = attempt.startedAt;
            this.entries.set(key, entry);
            try { this.save(); }
            catch (error) {
                entry.attempts.pop();
                if (!entry.attempts.length) this.entries.delete(key);
                throw error;
            }
            // The request outlives the browser connection; the card polls this journal.
            this.execution = this.lab.execute(review.ticket).then(response => {
                const asset = assetOf(attempt.kind, response);
                Object.assign(attempt, asset ? { status: 'done', asset } : { status: 'uncertain', error: 'The generation finished without a viewable result; check the gallery' });
            }, error => {
                let started = true;
                try { started = this.lab.executionStatus(review.ticket).status !== 'reviewed'; } catch {}
                Object.assign(attempt, { status: started ? 'uncertain' : 'failed', error: String(error?.message || 'Generation failed').slice(0, 500),
                    ...(error?.taskId ? { taskId: String(error.taskId).slice(0, 200) } : {}) });
            }).finally(() => {
                attempt.finishedAt = new Date(this.now()).toISOString(); entry.updatedAt = attempt.finishedAt; delete attempt.ticket;
                try { this.save(); } catch (error) { console.error('Media chat request record could not be saved:', error.message); }
            });
            return { status: 'running', state: this.publicState(key) };
        } finally { this.pending.delete(key); }
    }
}

module.exports = { MediaChatRequests, stableParameters: stable };
