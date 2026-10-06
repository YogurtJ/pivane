const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Minimal DOM: enough for the card module to build, attach, detach and repaint cards.
class Node {
    constructor(tag) { Object.assign(this, { tag, children: [], parentNode: null, dataset: {}, attributes: {}, listeners: {}, className: '', textContent: '', hidden: false }); this.classList = { toggle() {}, add() {}, remove() {} }; }
    append(...nodes) { for (const node of nodes) { if (typeof node === 'string') continue; node.parentNode?.removeChild(node); node.parentNode = this; this.children.push(node); } }
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
    const timers = new Map(); let nextTimer = 1;
    const schedule = (fn, ms, repeat) => { const id = nextTimer++; timers.set(id, { fn, ms, repeat }); return id; };
    const documentListeners = {};
    const document = { createElement: tag => new Node(tag), createTextNode: text => text, activeElement: null, visibilityState: 'visible',
        addEventListener: (type, handler) => (documentListeners[type] ||= []).push(handler) };
    const context = { document, window: {}, globalThis: null, console, Promise, Map, Set, Object, Array, JSON, String, Number, Date, encodeURIComponent,
        setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: id => timers.delete(id),
        setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id) };
    context.globalThis = context; context.window = context;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-media-requests.js'), 'utf8'), context);
    // Run due timers: queued status fetches (30 ms) or one poll tick (2500 ms).
    const tick = async kind => {
        for (const [id, timer] of [...timers]) if (kind === 'poll' ? timer.repeat : !timer.repeat) { if (!timer.repeat) timers.delete(id); timer.fn(); }
        for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { api: context.PiMediaRequests, tick, pollers: () => [...timers.values()].filter(timer => timer.repeat).length, documentListeners, document };
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
