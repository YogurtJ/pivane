const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const privateFiles = require('./pi-private-files');

// In-chat media requests: a validated plan shown as a chat card, executed only
// when the user confirms that card. The plan id correlates the card with its
// attempts so a refresh, another tab or the phone sees the same state instead
// of offering a second paid submission. Generation itself is the lab's
// review/execute ticket; this journal never retries or replays a request.
// Confirmed cards wait in a small in-memory queue while every execution slot is
// busy; a queued request has not been sent anywhere and can be cancelled.

const KEY = /^plan-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_KEYS = 2000;
const MAX_ATTEMPTS = 20;
const MAX_QUEUED = 20;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const ASSET_URL = /^\/(images|videos|audio)\/[^/?#\\]+$/;
const ACTIVE = new Set(['running', 'queued']);
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
        this.waiting = [];          // { key, attempt, entry, modelId, parameters, model, bytes } in confirmation order
        this.executions = new Set();
        try { this.entries = this.load(); }
        catch (error) {
            // Keep the server usable; refuse new submissions rather than overwrite unreadable records.
            this.entries = new Map(); this.unavailable = error.message;
        }
        this.lab.onSlotFree?.(() => { void this.pump(); });
    }

    // Settles when every request started so far has finished (tests and orderly shutdown).
    get execution() { return Promise.allSettled([...this.executions]).then(() => this.executions.size ? this.execution : undefined); }

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
        const at = new Date(this.now()).toISOString();
        for (const entry of items) {
            if (!entry || !KEY.test(entry.key) || !Array.isArray(entry.attempts)) continue;
            for (const attempt of entry.attempts) {
                if (attempt.status === 'running') {
                    // The process stopped while a paid request was in flight: its outcome is unknown.
                    Object.assign(attempt, { status: 'uncertain', error: 'Pivane restarted while this request was running; check the gallery before generating again', finishedAt: at });
                    interrupted = true;
                } else if (attempt.status === 'queued') {
                    // Queued requests were never sent; the queue itself lives in memory.
                    Object.assign(attempt, { status: 'failed', error: 'Pivane restarted before this request started; nothing was submitted', finishedAt: at });
                    interrupted = true;
                }
                delete attempt.ticket;
            }
            entries.set(entry.key, entry);
        }
        if (interrupted) this.save(entries);
        return entries;
    }

    save(entries = this.entries) {
        const items = [...entries.values()].sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).slice(-MAX_KEYS);
        if (items.length < entries.size) for (const key of [...entries.keys()]) if (!items.some(item => item.key === key) && !this.waiting.some(item => item.key === key)) entries.delete(key);
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            privateFiles.writePrivateFileSync(temporary, JSON.stringify(items.map(({ key, updatedAt, attempts }) => ({
                key, updatedAt, attempts: attempts.map(({ ticket, ...stored }) => stored) })), null, 1));
            fs.renameSync(temporary, this.file);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    }

    trySave(context) { try { this.save(); } catch (error) { console.error(`Media chat request record could not be saved (${context}):`, error.message); } }

    publicState(key) {
        const entry = this.entries.get(key);
        if (!entry) return { key, attempts: [] };
        return { key, attempts: entry.attempts.map(({ ticket, ...attempt }) => {
            if (attempt.status === 'queued') return { ...attempt, position: this.waiting.findIndex(item => item.attempt.id === attempt.id) + 1 || null };
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
        if (ACTIVE.has(previous?.status)) fail('This request is already running', 409, { state: this.publicState(key) });
        // Another tab or a double click must not create a second paid request.
        if (previous && again !== true) fail('This card was already submitted; choose to generate again explicitly', 409, { state: this.publicState(key) });
        if ((this.entries.get(key)?.attempts.length || 0) >= MAX_ATTEMPTS) fail('Too many generations from one card; ask the Agent for a new request', 429);
        this.pending.add(key);
        try {
            const review = await this.lab.review({ modelId, parameters });
            if (!review.model.executable) { this.lab.discard?.(review.ticket); fail('Media backend is not configured for execution', 503); }
            // Run exactly what the card shows: normalized values go back for another confirmation.
            if (stable(review.parameters) !== stable(parameters)) {
                this.lab.discard?.(review.ticket);
                return { status: 'changed', parameters: review.parameters, warnings: review.warnings, state: this.publicState(key) };
            }
            // Earlier confirmations go first; a busy slot queues instead of refusing.
            const queue = this.waiting.length > 0 || !this.lab.canExecute(review.model);
            const bytes = Buffer.byteLength(JSON.stringify(review.parameters));
            if (queue && (this.waiting.length >= MAX_QUEUED || this.waiting.reduce((total, item) => total + item.bytes, 0) + bytes > MAX_QUEUED_BYTES)) {
                this.lab.discard?.(review.ticket);
                fail('Too many media requests are waiting; try again after some finish', 429);
            }
            const at = new Date(this.now()).toISOString();
            const attempt = { id: randomUUID(), status: queue ? 'queued' : 'running', modelId: review.model.id, modelName: review.model.name, kind: review.model.kind,
                // Attachments stay in the gallery history, not in this small journal.
                parameters: bytes <= 64 * 1024 ? review.parameters : null, ...(queue ? { queuedAt: at } : { startedAt: at, ticket: review.ticket }) };
            const entry = this.entries.get(key) || { key, attempts: [] };
            entry.attempts.push(attempt); entry.updatedAt = at;
            this.entries.set(key, entry);
            try { this.save(); }
            catch (error) {
                entry.attempts.pop();
                if (!entry.attempts.length) this.entries.delete(key);
                this.lab.discard?.(review.ticket);
                throw error;
            }
            if (queue) {
                // The ticket would expire while waiting; the request is reviewed again when a slot frees.
                this.lab.discard?.(review.ticket);
                this.waiting.push({ key, attempt, entry, modelId, parameters: review.parameters, model: review.model, bytes });
                void this.pump();
                return { status: 'queued', state: this.publicState(key) };
            }
            this.start(attempt, entry, review.ticket);
            return { status: 'running', state: this.publicState(key) };
        } finally { this.pending.delete(key); }
    }

    cancel(input = {}) {
        const { key } = input;
        if (!KEY.test(key || '')) fail('Unknown media plan id');
        const index = this.waiting.findIndex(item => item.key === key);
        if (index < 0) fail('Only a queued request can be cancelled; a running request has already been sent', 409, { state: this.publicState(key) });
        const [item] = this.waiting.splice(index, 1);
        const at = new Date(this.now()).toISOString();
        Object.assign(item.attempt, { status: 'cancelled', finishedAt: at }); item.entry.updatedAt = at;
        this.trySave('cancel');
        return { status: 'cancelled', state: this.publicState(key) };
    }

    // Start queued requests in confirmation order while slots allow; each is reviewed again first.
    async pump() {
        if (this.pumping) { this.pumpAgain = true; return; }
        this.pumping = true;
        try {
            do {
                this.pumpAgain = false;
                for (const item of [...this.waiting]) {
                    if (!this.waiting.includes(item) || !this.lab.canExecute(item.model)) continue;
                    let review;
                    try { review = await this.lab.review({ modelId: item.modelId, parameters: item.parameters }); }
                    catch (error) { if (this.waiting.includes(item)) this.notStarted(item, error.message || 'Review failed'); continue; }
                    // Cancelled during the review, or the configuration changed what would be sent.
                    if (!this.waiting.includes(item)) { this.lab.discard?.(review.ticket); continue; }
                    if (stable(review.parameters) !== stable(item.parameters) || !review.model.executable) {
                        this.lab.discard?.(review.ticket);
                        this.notStarted(item, 'The model configuration changed while this request waited; review the card again');
                        continue;
                    }
                    if (!this.lab.canExecute(review.model)) { this.lab.discard?.(review.ticket); this.pumpAgain = true; break; }
                    this.waiting.splice(this.waiting.indexOf(item), 1);
                    const at = new Date(this.now()).toISOString();
                    Object.assign(item.attempt, { status: 'running', startedAt: at, ticket: review.ticket }); item.entry.updatedAt = at;
                    this.trySave('start');
                    this.start(item.attempt, item.entry, review.ticket);
                }
            } while (this.pumpAgain && this.waiting.length);
        } finally { this.pumping = false; }
    }

    notStarted(item, message) {
        this.waiting.splice(this.waiting.indexOf(item), 1);
        const at = new Date(this.now()).toISOString();
        Object.assign(item.attempt, { status: 'failed', error: String(message).slice(0, 500), finishedAt: at }); item.entry.updatedAt = at;
        this.trySave('not started');
    }

    start(attempt, entry, ticket) {
        // The request outlives the browser connection; the card polls this journal.
        const execution = this.lab.execute(ticket).then(response => {
            const asset = assetOf(attempt.kind, response);
            Object.assign(attempt, asset ? { status: 'done', asset } : { status: 'uncertain', error: 'The generation finished without a viewable result; check the gallery' });
        }, error => {
            let started = true;
            try { started = this.lab.executionStatus(ticket).status !== 'reviewed'; } catch {}
            Object.assign(attempt, { status: started ? 'uncertain' : 'failed', error: String(error?.message || 'Generation failed').slice(0, 500),
                ...(error?.taskId ? { taskId: String(error.taskId).slice(0, 200) } : {}) });
        }).finally(() => {
            attempt.finishedAt = new Date(this.now()).toISOString(); entry.updatedAt = attempt.finishedAt; delete attempt.ticket;
            this.trySave('finish');
            this.executions.delete(execution);
        });
        this.executions.add(execution);
    }
}

module.exports = { MediaChatRequests, stableParameters: stable };
