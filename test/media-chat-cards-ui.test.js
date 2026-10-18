const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal DOM: enough for the card module to build, attach, detach and repaint cards.
class Node {
    constructor(tag) { Object.assign(this, { tag, children: [], parentNode: null, dataset: {}, attributes: {}, listeners: {}, className: '', textContent: '', hidden: false }); this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...nodes) { for (const node of nodes) { if (typeof node === 'string') continue; node.parentNode?.removeChild(node); node.parentNode = this; this.children.push(node); } }
    get childNodes() { return this.children; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { const siblings = this.parentNode?.children || []; return siblings[siblings.indexOf(this) + 1] || null; }
    insertBefore(node, cursor) { node.parentNode?.removeChild(node); node.parentNode = this; const index = cursor ? this.children.indexOf(cursor) : this.children.length; this.children.splice(index, 0, node); return node; }
    appendChild(node) { this.append(node); return node; }
    removeChild(node) { this.children = this.children.filter(child => child !== node); node.parentNode = null; }
    remove() { this.parentNode?.removeChild(this); }
    replaceChildren(...nodes) { for (const child of this.children) child.parentNode = null; this.children = []; this.append(...nodes); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
    contains(node) { for (let item = node; item; item = item.parentNode) if (item === this) return true; return false; }
    querySelector() { return null; }
    focus() {}
    get isConnected() { let item = this; while (item.parentNode) item = item.parentNode; return item === documentRoot; }
}
let documentRoot;

function load() {
    documentRoot = new Node('html');
    const timers = new Map(); let nextTimer = 1, now = 0;
    const schedule = (fn, ms, repeat) => { const id = nextTimer++; timers.set(id, { fn, ms, repeat, at: now + ms }); return id; };
    const documentListeners = {};
    const document = { createElement: tag => new Node(tag), createTextNode: text => Object.assign(new Node('#text'), { textContent: text }), activeElement: null, visibilityState: 'visible',
        addEventListener: (type, handler) => (documentListeners[type] ||= []).push(handler) };
    const context = { document, window: {}, globalThis: null, console, Promise, Map, Set, Object, Array, JSON, String, Number, Date, encodeURIComponent, WeakRef, AbortController,
        setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id) };
    context.globalThis = context; context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-media-requests.js'), 'utf8'), context);
    const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
    const runTimer = async (id, timer) => {
        if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
        timer.fn(); await drain();
    };
    // Existing behavior tests can select one queue/poll tick without advancing deadlines.
    const tick = async kind => {
        for (const [id, timer] of [...timers]) if (kind === 'poll' ? timer.repeat : !timer.repeat && timer.ms === 30) await runTimer(id, timer);
        await drain();
    };
    // Deadline tests run timers in chronological order, draining abort/fetch continuations between callbacks.
    const advance = async ms => {
        const target = now + ms;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
            if (!due) break;
            now = due[1].at; await runTimer(...due);
        }
        now = target; await drain();
    };
    return { api: context.PiMediaRequests, tick, advance, pollers: () => [...timers.values()].filter(timer => timer.repeat).length,
        pendingTimeouts: ms => [...timers.values()].filter(timer => !timer.repeat && timer.ms === ms).length, documentListeners, document };
}

const KEY = 'plan-11111111-2222-4333-8444-555555555555';
const message = { role: 'toolResult', toolName: 'media_generate', details: { plan: { id: KEY, kind: 'image', modelId: 'media:test:model', summary: 'Synthetic card', parameters: { prompt: 'synthetic' } } } };
const running = { key: KEY, attempts: [{ id: 'a', status: 'running', kind: 'image', parameters: { prompt: 'synthetic' } }] };
const done = { key: KEY, attempts: [{ id: 'a', status: 'done', kind: 'image', parameters: { prompt: 'synthetic' }, asset: { url: '/images/lab_synthetic.png', kind: 'image' } }] };

test('a running card rebuilt after the transcript was replaced resumes polling and shows the result', async () => {
    const { api, tick, pollers } = load();
    let server = running; const calls = [];
    const fetch = async url => { calls.push(url); if (url === '/api/pi/media/lab') return { models: [] }; return { requests: { [KEY]: server } }; };
    const cards = api.create({ fetch });
    const transcript = new Node('div'); documentRoot.append(transcript);
    const first = cards.render(message); transcript.append(first);
    await tick('queue');
    assert.equal(first.dataset.state, 'running');
    assert.equal(pollers(), 1);
    // Session switch or reconnect: the transcript shows a loading state, so the poll tick finds no card and stops.
    transcript.replaceChildren();
    await tick('poll');
    assert.equal(pollers(), 0);
    server = done;
    const second = cards.render(message); transcript.append(second);
    await tick('queue');
    assert.equal(second.dataset.state, 'done', 'rebuilt card must fetch the finished state without a page reload');
    assert.ok(calls.filter(url => url.startsWith('/api/pi/media/chat/requests')).length >= 2);
});

test('returning to a hidden tab refreshes running cards at once', async () => {
    const { api, tick, documentListeners, document } = load();
    let server = running;
    const cards = api.create({ fetch: async url => url === '/api/pi/media/lab' ? { models: [] } : { requests: { [KEY]: server } } });
    const transcript = new Node('div'); documentRoot.append(transcript);
    const card = cards.render(message); transcript.append(card);
    await tick('queue');
    assert.equal(card.dataset.state, 'running');
    server = done; document.visibilityState = 'visible';
    for (const handler of documentListeners.visibilitychange || []) handler();
    await tick('queue');
    assert.equal(card.dataset.state, 'done');
});

test('a queued card offers cancellation and keeps polling until it starts', async () => {
    const { api, tick, pollers } = load();
    const queued = { key: KEY, attempts: [{ id: 'a', status: 'queued', position: 2, kind: 'image', parameters: { prompt: 'synthetic' } }] };
    let server = queued; const posts = [];
    const fetch = async (url, options) => {
        if (url === '/api/pi/media/lab') return { models: [] };
        if (options?.method === 'POST') { posts.push([url, JSON.parse(options.body)]); server = { key: KEY, attempts: [{ ...queued.attempts[0], status: 'cancelled', position: undefined }] }; return { status: 'cancelled', state: server }; }
        return { requests: { [KEY]: server } };
    };
    const cards = api.create({ fetch });
    const transcript = new Node('div'); documentRoot.append(transcript);
    const card = cards.render(message); transcript.append(card);
    await tick('queue');
    assert.equal(card.dataset.state, 'queued');
    assert.equal(pollers(), 1, 'queued cards keep polling so they show when they start');
    const all = node => [node, ...node.children.flatMap(all)];
    const text = node => [node.textContent, ...node.children.map(text)].join('');
    assert.match(text(card), /前面还有 1 个请求/);
    const cancel = all(card).find(node => node.tag === 'button' && text(node).includes('取消排队'));
    assert.ok(cancel, 'cancel button is shown for a queued card');
    cancel.listeners.click[0]();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.deepEqual(posts, [['/api/pi/media/chat/requests/cancel', { key: KEY }]]);
    assert.equal(cards.planOf(message).id, KEY);
    const current = transcript.children.at(-1);
    assert.equal(current.dataset.state, 'cancelled');
    // Nothing was sent, so confirming again is a single plain confirmation.
    assert.ok(all(current).some(node => node.tag === 'button' && text(node) === '确认生成'));
});

const all = node => [node, ...node.children.flatMap(all)];
const text = node => [node.textContent, ...node.children.map(text)].join('');
const click = (root, label) => {
    const button = all(root).find(node => node.tag === 'button' && text(node) === label);
    assert.ok(button, `button ${label}`); button.listeners.click[0]();
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const changedMessage = index => ({ ...message, details: { plan: { ...message.details.plan, id: `plan-11111111-2222-4333-8444-${String(index).padStart(12, '0')}` } } });

test('slow status reads coalesce poll and visibility refreshes without overlapping requests', async () => {
    const { api, tick, documentListeners } = load();
    const pending = deferred(); let reads = 0, active = 0, maximum = 0;
    const cards = api.create({ fetch: async url => {
        if (url.endsWith('/lab')) return { models: [] };
        reads++; active++; maximum = Math.max(maximum, active);
        if (reads > 1) await pending.promise;
        active--; return { requests: { [KEY]: running } };
    } });
    documentRoot.append(cards.render(message)); await tick('queue');
    for (let i = 0; i < 4; i++) {
        await tick('poll');
        for (const handler of documentListeners.visibilitychange) handler();
        await tick('queue');
    }
    assert.equal(reads, 2); assert.equal(maximum, 1);
    pending.resolve(); await settle();
    await tick('poll'); await tick('queue');
    assert.equal(reads, 3, 'polling continues after the shared request settles');
});

test('reset aborts only reads and rejects a late old-generation response for the same key', async () => {
    const { api, tick } = load(); const pending = deferred(); let reads = 0, signal;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (++reads === 1) { signal = options.signal; return pending.promise; }
        return { requests: { [KEY]: done } };
    } });
    const first = cards.render(message); documentRoot.append(first); await tick('queue');
    first.remove(); cards.reset(); assert.equal(signal.aborted, true);
    const second = cards.render(message); documentRoot.append(second); await tick('queue');
    assert.equal(second.dataset.state, 'done');
    pending.resolve({ requests: { [KEY]: running } }); await settle();
    assert.equal(second.dataset.state, 'done');
    assert.equal(first.dataset.state, 'pending', 'late results never repaint an unmounted card');
});

test('pruning one key from a shared read permits remount while preserving the other subscriber', async () => {
    const { api, tick } = load(); const pending = deferred(), other = changedMessage(2), otherKey = other.details.plan.id;
    let reads = 0, signal;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (++reads === 1) { signal = options.signal; return pending.promise; }
        return { requests: { [KEY]: done } };
    } });
    const first = cards.render(message), second = cards.render(other); documentRoot.append(first, second); await tick('queue');
    first.remove(); cards.prune(); assert.equal(signal.aborted, false);
    const replacement = cards.render(message); documentRoot.append(replacement); await tick('queue');
    pending.resolve({ requests: { [KEY]: running, [otherKey]: { ...running, key: otherKey } } }); await settle();
    assert.equal(replacement.dataset.state, 'done', 'the old batch cannot overwrite a remounted key');
    assert.equal(second.dataset.state, 'running');
    second.remove(); replacement.remove(); cards.prune();
});

test('a GET started before a confirmation cannot overwrite its POST receipt, and reset never cancels or replays the POST', async () => {
    const { api, tick } = load(); const read = deferred(), write = deferred(); let reads = 0; const posts = [];
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (options?.method === 'POST') { posts.push({ url, options, body: JSON.parse(options.body) }); return write.promise; }
        if (++reads === 1) return read.promise;
        return { requests: { [KEY]: done } };
    } });
    const first = cards.render(message); documentRoot.append(first); await tick('queue');
    click(first, '确认生成');
    first.remove(); cards.reset();
    const replacement = cards.render(message); documentRoot.append(replacement); await tick('queue');
    assert.equal(reads, 1, 'an outstanding confirmed write remains busy across a view reset');
    assert.equal(posts.length, 1); assert.equal(posts[0].options.signal, undefined);
    assert.equal(posts[0].body.confirmed, true);
    write.resolve({ state: done }); await settle();
    read.resolve({ requests: { [KEY]: running } }); await settle();
    assert.equal(replacement.dataset.state, 'done'); assert.equal(first.dataset.state, 'pending');
    assert.equal(posts.length, 1);
    replacement.remove(); cards.prune();
    const third = cards.render(message); documentRoot.append(third); await tick('queue');
    assert.equal(reads, 2, 'unmounted state is discarded and fetched on remount');
    assert.equal(posts.length, 1, 'remount reads the journal without replaying generation');
});

test('completed audio and video nodes stay connected and are reused by attempt ID across polls', async () => {
    const { api, tick } = load(); let server;
    const attempts = ['video', 'tts'].map((kind, index) => ({ id: kind, status: 'done', kind,
        asset: { kind, url: index ? '/audio/fixture.wav' : '/videos/fixture.mp4' } }));
    server = { attempts: [...attempts, running.attempts[0]] };
    const cards = api.create({ fetch: async url => url.endsWith('/lab') ? { models: [] } : { requests: { [KEY]: server } } });
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    const media = all(root).filter(node => ['video', 'audio'].includes(node.tag)); assert.equal(media.length, 2);
    const parent = media.map(node => node.parentNode);
    server = JSON.parse(JSON.stringify(server)); await tick('poll'); await tick('queue');
    const next = all(root).filter(node => ['video', 'audio'].includes(node.tag));
    assert.deepEqual(next, media); assert.ok(media.every((node, index) => node.isConnected && node.parentNode === parent[index]));
    server = { attempts: [attempts[0], { ...running.attempts[0], status: 'failed' }] };
    await tick('poll'); await tick('queue');
    assert.equal(all(root).filter(node => ['video', 'audio'].includes(node.tag)).length, 1, 'removed attempts leave no cached media row');
});

test('the editor keeps its unsaved form while a status read or catalog repaint completes', async () => {
    const { api, tick, document } = load();
    const cards = api.create({ fetch: async url => url.endsWith('/lab') ? { models: [] } : { requests: { [KEY]: { attempts: [] } } } });
    const root = cards.render(message); documentRoot.append(root);
    click(root, '修改参数'); await settle();
    const form = all(root).find(node => node.tag === 'form'); assert.ok(form);
    const input = new Node('textarea'); input.value = 'unsaved user text'; form.append(input); document.activeElement = input;
    await tick('queue');
    assert.equal(all(root).find(node => node.tag === 'form'), form); assert.equal(input.value, 'unsaved user text'); assert.equal(input.isConnected, true);
    root.remove(); cards.prune();
    const replacement = cards.render(message); documentRoot.append(replacement); await tick('queue');
    assert.equal(all(replacement).some(node => node.tag === 'form'), false, 'pruning does not retain detached form drafts');
});

test('unmounted async editor and mutation completion cannot register or repaint a detached card', async () => {
    const { api, tick } = load(); const catalog = deferred(), write = deferred(); let reads = 0, posts = 0;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return catalog.promise;
        if (options?.method === 'POST') { posts++; return write.promise; }
        reads++; return { requests: { [KEY]: { attempts: [] } } };
    } });
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    click(root, '修改参数'); click(root, '确认生成');
    root.remove(); cards.prune();
    catalog.resolve({ models: [] }); write.resolve({ state: done }); await settle();
    assert.equal(root.dataset.state, 'pending'); assert.equal(all(root).some(node => node.tag === 'form'), false);
    documentRoot.append(cards.render(message)); await tick('queue');
    assert.equal(reads, 2); assert.equal(posts, 1);
});

test('a pre-confirmation GET cannot regress the completed write receipt without a view reset', async () => {
    const { api, tick } = load(); const read = deferred(); let posts = 0;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (options?.method === 'POST') { posts++; return { state: done }; }
        return read.promise;
    } });
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    click(root, '确认生成'); await settle(); assert.equal(root.dataset.state, 'done');
    read.resolve({ requests: { [KEY]: running } }); await settle();
    assert.equal(root.dataset.state, 'done'); assert.equal(posts, 1);
});

test('pruning the last subscriber aborts its GET and ignores a late rejection', async () => {
    const { api, tick } = load(); const read = deferred(); let signal, reads = 0;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (++reads === 1) { signal = options.signal; return read.promise.then(() => { throw Error('late aborted query'); }); }
        return { requests: { [KEY]: done } };
    } });
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    root.remove(); cards.prune(); assert.equal(signal.aborted, true);
    const replacement = cards.render(message); documentRoot.append(replacement); await tick('queue');
    read.resolve(); await settle();
    assert.equal(replacement.dataset.state, 'done'); assert.doesNotMatch(text(replacement), /late aborted query/);
});

test('status batches retain the 100-key limit and do not accept unrelated response keys', async () => {
    const { api, tick } = load(); const sizes = []; let unrelatedReads = 0;
    const cards = api.create({ fetch: async url => {
        if (url.endsWith('/lab')) return { models: [] };
        const keys = new URL(url, 'http://fixture').searchParams.get('keys').split(','); sizes.push(keys.length);
        if (keys.includes(KEY)) unrelatedReads++;
        return { requests: { ...Object.fromEntries(keys.map(key => [key, { attempts: [] }])), [KEY]: done } };
    } });
    for (let i = 0; i < 201; i++) documentRoot.append(cards.render(changedMessage(i)));
    for (let i = 0; i < 3; i++) await tick('queue');
    assert.deepEqual(sizes, [100, 100, 1]);
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    assert.equal(unrelatedReads, 1, 'unrequested response state is never cached');
});

test('server-adjusted parameters require another explicit confirmation without automatic POST replay', async () => {
    const { api, tick } = load(); const posts = []; const adjusted = { prompt: 'server-normalized prompt' };
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (options?.method === 'POST') {
            posts.push(JSON.parse(options.body));
            return posts.length === 1 ? { status: 'changed', parameters: adjusted, state: { attempts: [] } } : { state: done };
        }
        return { requests: { [KEY]: { attempts: [] } } };
    } });
    const root = cards.render(message); documentRoot.append(root); await tick('queue');
    click(root, '确认生成'); await settle();
    assert.equal(posts.length, 1); assert.match(text(root), /服务端调整了部分参数/);
    await tick('poll'); await tick('queue'); assert.equal(posts.length, 1);
    click(root, '确认生成'); await settle();
    assert.equal(posts.length, 2); assert.deepEqual(posts[1].parameters, adjusted); assert.equal(posts[1].confirmed, true);
});

test('a hung status GET times out after eight seconds and the next poll recovers with at most one active read', async () => {
    const { api, advance, pendingTimeouts, pollers, documentListeners } = load();
    let reads = 0, active = 0, maximum = 0, aborts = 0; const signals = [];
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        signals.push(options.signal); reads++; active++; maximum = Math.max(maximum, active);
        try {
            if (reads === 2) await new Promise((_, reject) => options.signal.addEventListener('abort', () => {
                aborts++; reject(new Error('Synthetic read aborted'));
            }, { once: true }));
            return { requests: { [KEY]: reads === 1 ? running : done } };
        } finally { active--; }
    } });
    const root = cards.render(message); documentRoot.append(root);
    await advance(30); assert.equal(root.dataset.state, 'running');
    assert.equal(pendingTimeouts(8000), 0, 'a completed read clears its deadline');
    await advance(2530); assert.equal(reads, 2); assert.equal(pendingTimeouts(8000), 1);
    for (let i = 0; i < 4; i++) for (const handler of documentListeners.visibilitychange) handler();
    await advance(7999);
    assert.equal(reads, 2, 'polling and visibility events share the hung read');
    assert.equal(signals[1].aborted, false); assert.equal(maximum, 1);
    await advance(1);
    assert.equal(signals[1].aborted, true); assert.equal(aborts, 1); assert.equal(active, 0);
    assert.equal(pendingTimeouts(8000), 0); assert.match(text(root), /媒体状态查询超时/);
    assert.equal(root.dataset.state, 'running', 'read timeout does not change generation status');
    await advance(2000);
    assert.equal(reads, 3); assert.equal(root.dataset.state, 'done');
    assert.equal(maximum, 1); assert.equal(active, 0); assert.equal(pendingTimeouts(8000), 0); assert.equal(pollers(), 0);
    assert.doesNotMatch(text(root), /查询超时|Synthetic read aborted/, 'successful refresh clears the read timeout notice');
});

test('reset and unmount aborts cancel the deadline silently and cannot add errors to a new view', async () => {
    for (const action of ['reset', 'prune']) {
        const { api, advance, pendingTimeouts } = load(); let reads = 0, aborts = 0;
        const cards = api.create({ fetch: async (url, options) => {
            if (url.endsWith('/lab')) return { models: [] };
            if (++reads === 1) return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
                aborts++; reject(new Error('Synthetic view abort'));
            }, { once: true }));
            return { requests: { [KEY]: done } };
        } });
        const first = cards.render(message); documentRoot.append(first); await advance(30);
        first.remove(); cards[action](); await advance(0);
        assert.equal(aborts, 1, action); assert.equal(pendingTimeouts(8000), 0, action);
        const second = cards.render(message); documentRoot.append(second); await advance(30); await advance(8000);
        assert.equal(second.dataset.state, 'done', action);
        assert.doesNotMatch(text(second), /查询超时|Synthetic view abort/, action);
        assert.doesNotMatch(text(first), /查询超时|Synthetic view abort/, 'the old DOM also stays untouched');
    }
});

test('a superseded GET deadline cannot cancel, replay or overwrite the pending or completed POST', async () => {
    for (const finishWriteEarly of [false, true]) {
        const { api, advance, pendingTimeouts } = load(); const write = deferred(); let posts = 0, aborts = 0, postOptions;
        const cards = api.create({ fetch: async (url, options) => {
            if (url.endsWith('/lab')) return { models: [] };
            if (options?.method === 'POST') { posts++; postOptions = options; return write.promise; }
            return new Promise((_, reject) => options.signal.addEventListener('abort', () => {
                aborts++; reject(new Error('Synthetic superseded read aborted'));
            }, { once: true }));
        } });
        const root = cards.render(message); documentRoot.append(root); await advance(30);
        click(root, '确认生成');
        if (finishWriteEarly) { write.resolve({ state: done }); await advance(0); }
        await advance(8000);
        assert.equal(aborts, 1); assert.equal(pendingTimeouts(8000), 0);
        assert.doesNotMatch(text(root), /查询超时|Synthetic superseded read aborted/);
        assert.equal(posts, 1); assert.equal(postOptions.signal, undefined, 'POST has no cancellation signal');
        if (!finishWriteEarly) {
            assert.match(text(root), /正在提交/);
            await advance(16000); assert.equal(posts, 1, 'read deadlines never retry a confirmed write');
            write.resolve({ state: done }); await advance(0);
        }
        assert.equal(root.dataset.state, 'done'); assert.equal(posts, 1);
        assert.doesNotMatch(text(root), /查询超时|Synthetic superseded read aborted/);
    }
});

test('a read adapter ignoring abort cannot hold the timeout gate or backfill a late response', async () => {
    const { api, advance } = load(); const stuck = deferred(); let reads = 0, staleSignal;
    const cards = api.create({ fetch: async (url, options) => {
        if (url.endsWith('/lab')) return { models: [] };
        if (++reads === 1) return { requests: { [KEY]: running } };
        if (reads === 2) { staleSignal = options.signal; return stuck.promise; }
        return { requests: { [KEY]: done } };
    } });
    const root = cards.render(message); documentRoot.append(root); await advance(12560);
    assert.equal(staleSignal.aborted, true); assert.equal(reads, 3); assert.equal(root.dataset.state, 'done');
    stuck.resolve({ requests: { [KEY]: running } }); await advance(0);
    assert.equal(root.dataset.state, 'done'); assert.doesNotMatch(text(root), /查询超时/);
});
