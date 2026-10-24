'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');

// Run this before loading browser/server dependencies. Keep only local tooling and
// non-secret OS settings; no vendor credentials or deployment/instance aliases.
function isolateEnvironment() {
    const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_MODULE', 'CHROMIUM_PATH']);
    let removed = 0;
    for (const key of Object.keys(process.env)) if (!keep.has(key)) { delete process.env[key]; removed++; }
    return { policy: 'explicit local-tooling allowlist; no provider or instance variables', removed };
}

async function createFixture(root) {
    const express = require('express');
    const { WebSocketServer, WebSocket } = require('ws');
    const cwd = '/synthetic/batch4-frontend';
    const otherCwd = '/synthetic/batch4-frontend-other';
    const sessions = ['a', 'b'].map(id => ({ id, cwd, name: `Synthetic ${id}`, messageCount: 4 }));
    sessions.push({ id: 'c', cwd: otherCwd, name: 'Synthetic other project', messageCount: 4 });
    const models = Array.from({ length: 426 }, (_, i) => ({ provider: i < 200 ? 'fixture-a' : 'fixture-b', id: `model/${i}`, name: `Synthetic model ${i}`, input: ['text', 'image'], contextWindow: 32000 }));
    const commands = Array.from({ length: 80 }, (_, i) => ({ name: `fixture-${i}`, source: 'extension', description: `Synthetic command ${i} <img src=x onerror=alert(1)>` }));
    const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const runtime = { model: models[0], thinkingLevel: 'off', isStreaming: false, isCompacting: false };
    const messages = [
        { role: 'user', content: 'SYNTHETIC_QUESTION', timestamp: 1 },
        { role: 'assistant', content: [{ type: 'toolCall', id: 'fixture-tool', name: 'read', arguments: { path: 'synthetic.txt' } }], timestamp: 2 },
        { role: 'toolResult', toolCallId: 'fixture-tool', toolName: 'read', content: [{ type: 'text', text: 'SYNTHETIC_TOOL_OUTPUT' }], timestamp: 3 },
        { role: 'assistant', content: [{ type: 'text', text: 'SYNTHETIC_ANSWER' }], timestamp: 4 }
    ];
    const fileReads = [], apiReads = [], rpc = [], unknown = [], sockets = new Map(), timers = new Map();
    let serial = 0, fileDelayMs = 900, failNextFile = false;
    const app = express();
    app.use(express.json());
    app.use('/api', (req, res) => {
        const url = new URL(req.originalUrl, 'http://synthetic.invalid');
        const endpoint = url.pathname;
        apiReads.push({ method: req.method, endpoint });
        if (req.method !== 'GET') { unknown.push({ method: req.method, endpoint }); return res.status(405).json({ error: 'Synthetic fixture is read-only' }); }
        const json = value => res.json(value);
        if (endpoint === '/api/access/status') return json({ enabled: false, authenticated: true });
        if (endpoint === '/api/pi/status') return json({ ok: true, composerTools: true, projectRoots: ['/synthetic'] });
        if (endpoint === '/api/pi/projects') return json({ projects: [{ cwd, name: 'Synthetic project', sessionCount: 2 }, { cwd: otherCwd, name: 'Synthetic other project', sessionCount: 1 }], roots: ['/synthetic'] });
        if (endpoint === '/api/pi/sessions') return json({ sessions: sessions.filter(session => session.cwd === url.searchParams.get('cwd')) });
        if (endpoint === '/api/pi/activity') return json({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
        if (endpoint === '/api/pi/directories') return json({ cwd: '/synthetic', directories: [{ path: cwd, name: 'Synthetic project' }, { path: otherCwd, name: 'Synthetic other project' }] });
        if (endpoint === '/api/pi/profiles') return json({ profiles: [] });
        if (endpoint === '/api/pi/settings/model-favorites') return json({ version: 1, revision: 1, favorites: [] });
        if (endpoint === '/api/pi/settings/updates/notifications') return json({ enabled: false, available: false, idle: true });
        if (endpoint === '/api/pi/composer/catalog') return json({ cwd: url.searchParams.get('cwd'), builtins: [], templates: [], warnings: [] });
        if (endpoint === '/api/pi/composer/files') {
            const read = { id: fileReads.length + 1, cwd: url.searchParams.get('cwd'), query: url.searchParams.get('q'), start: performance.now(), delayMs: fileDelayMs, fail: failNextFile };
            failNextFile = false; fileReads.push(read);
            const timer = setTimeout(() => {
                timers.delete(read.id);
                read.end = performance.now();
                read.durationMs = read.end - read.start;
                const files = [{ path: `${read.query}/button click.js` }, { path: `${read.query}/组件.ts` }];
                if (['alpha', 'beta', 'scope', 'project', 'reconnect', 'old'].includes(read.query)) files.push({ path: `batch4-response-${read.id}.txt` });
                if (read.fail) res.status(503).json({ error: 'Synthetic file query failure' });
                else res.json({ cwd: read.cwd, files, truncated: false });
            }, fileDelayMs);
            timers.set(read.id, timer);
            return;
        }
        if (endpoint.endsWith('/workflow')) return json({ prompts: [], replies: [], versions: [], leafId: null });
        if (endpoint.endsWith('/deferred')) return json({ revision: 'synthetic-1', jobs: [] });
        if (endpoint === '/api/prompts' || ['/api/history', '/api/video/history', '/api/tts/history'].includes(endpoint)) return json([]);
        // Explicitly harmless capability/optional reads used by the real index.
        if (['/api/media/connections', '/api/pi/settings/resources', '/api/pi/model-speed/capabilities', '/api/pi/transcription/status'].includes(endpoint)) return json({ configured: false, resources: { extensions: [], prompts: [], skills: [], themes: [] } });
        unknown.push({ method: req.method, endpoint });
        return res.status(404).json({ error: 'Unrecognized synthetic API endpoint' });
    });
    for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
    app.use(express.static(path.join(root, 'public')));
    const server = http.createServer(app);
    const wss = new WebSocketServer({ server, path: '/api/pi/ws' });
    wss.on('connection', socket => {
        const record = { id: ++serial, socket, sessionId: null, opened: false };
        sockets.set(record.id, record);
        socket.on('message', raw => {
            const command = JSON.parse(String(raw));
            rpc.push({ socket: record.id, type: command.type, sessionId: command.sessionId });
            let data;
            if (command.type === 'open_session') {
                record.sessionId = command.sessionId; record.opened = true;
                data = { session: sessions.find(session => session.id === command.sessionId), state: runtime, models: { models }, thinkingLevels: { levels }, commands: { commands }, stats: {}, messages: { messages } };
            } else if (command.type === 'get_state') data = runtime;
            else if (command.type === 'get_session_stats') data = {};
            else if (command.type === 'get_messages') data = { messages };
            else if (command.type === 'get_available_models') data = { models };
            else if (command.type === 'get_available_thinking_levels') data = { levels };
            else if (command.type === 'get_session_tree') data = { tree: [], entries: [] };
            else if (command.type === 'set_thinking_level') { runtime.thinkingLevel = command.level; data = {}; }
            else { unknown.push({ rpc: command.type }); data = {}; }
            socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
        });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
        base, cwd, otherCwd, models, commands, levels, runtime, fileReads, apiReads, rpc, unknown, sockets,
        setFileDelay(ms) { fileDelayMs = ms; }, failNextFile() { failNextFile = true; },
        currentSocket() { return [...sockets.values()].findLast(record => record.opened && record.socket.readyState === WebSocket.OPEN); },
        send(event) { this.currentSocket().socket.send(JSON.stringify(event)); },
        disconnect() { this.currentSocket().socket.close(1012, 'Synthetic reconnect boundary'); },
        async close() {
            for (const timer of timers.values()) clearTimeout(timer);
            timers.clear();
            for (const socket of wss.clients) socket.terminate();
            await new Promise(resolve => wss.close(resolve));
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
    };
}

// Observe the real methods and browser primitives. No alternate implementation,
// cache or request deduplication is installed in the page.
function installInstrumentation({ cwd, locale }) {
    localStorage.setItem('pi.web.cwd', cwd);
    if (!localStorage.getItem(`pi.web.session:${cwd}`)) localStorage.setItem(`pi.web.session:${cwd}`, 'a');
    if (!localStorage.getItem('pi.workspace.language')) localStorage.setItem('pi.workspace.language', locale);
    localStorage.setItem('pi.web.transcriptMode', 'full');
    const data = window.batch4 = { calls: [], dom: [], measures: [], ws: [], fetches: [], longTasks: [], mark: 0, oldNodes: null };
    const time = () => performance.now();
    const ids = new Set(['pi-thinking-select', 'pi-mobile-thinking', 'pi-command-menu', 'pi-model-results']);
    const originalReplace = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function(...args) {
        const observed = ids.has(this.id), start = observed ? time() : 0;
        const before = observed ? this.children.length : 0;
        const result = originalReplace.apply(this, args);
        if (observed) data.dom.push({ kind: 'replaceChildren', id: this.id, before, after: this.children.length, ms: time() - start, at: start });
        return result;
    };
    const html = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', { ...html, set(value) {
        const observed = ids.has(this.id), start = observed ? time() : 0;
        const before = observed ? this.children.length : 0;
        html.set.call(this, value);
        if (observed) data.dom.push({ kind: 'innerHTML', id: this.id, before, after: this.children.length, ms: time() - start, at: start });
    } });
    const measureText = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(text) {
        const start = time(), result = measureText.call(this, text);
        data.measures.push({ text, font: this.font, width: result.width, ms: time() - start, at: start });
        return result;
    };
    const fetch = window.fetch;
    window.fetch = async function(...args) {
        const url = String(args[0]), start = time();
        const read = { url, start };
        if (url.includes('/composer/files?')) data.fetches.push(read);
        try { const response = await fetch.apply(this, args); read.status = response.status; return response; }
        finally { read.end = time(); read.ms = read.end - start; }
    };
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
        constructor(...args) {
            const url = new URL(String(args[0]), location.href);
            if (url.host !== location.host || url.pathname !== '/api/pi/ws') throw new Error('Blocked unknown synthetic-fixture WebSocket');
            super(...args);
            window.batch4Socket = this;
        }
        addEventListener(type, listener, options) {
            if (type !== 'message') return super.addEventListener(type, listener, options);
            return super.addEventListener(type, function(event) {
                const start = time(), value = JSON.parse(event.data);
                try { return listener.call(this, event); }
                finally { data.ws.push({ type: value.type, command: value.command, sample: value.batch4Sample, ms: time() - start, at: start }); }
            }, options);
        }
    };
    for (const [name, methods, field] of [
        ['PiComposerTools', ['complete', 'show', 'files', 'reset', 'setCommands'], 'composer'],
        ['PiModelPicker', ['update', 'render'], 'picker']
    ]) Object.defineProperty(window, name, { configurable: true, set(Class) {
        for (const method of methods) {
            const original = Class.prototype[method];
            Class.prototype[method] = function(...args) {
                data[field] = this;
                const start = time();
                try { return original.apply(this, args); }
                finally {
                    data.calls.push({ name: `${name}.${method}`, ms: time() - start, at: start,
                        ...(method === 'show' ? { paths: args[0].map(item => item.file?.path || item.command?.name) } : {}),
                        ...(method === 'files' ? { query: args[0] } : {}),
                        ...(field === 'composer' ? { scope: this.host.context().key, epoch: this.epoch, request: this.request } : {}) });
                }
            };
        }
        Object.defineProperty(window, name, { value: Class, writable: true, configurable: true });
    } });
    new PerformanceObserver(records => data.longTasks.push(...records.getEntries().map(entry => ({ start: entry.startTime, ms: entry.duration })))).observe({ type: 'longtask', buffered: true });
    window.batch4Begin = () => {
        data.calls.length = data.dom.length = data.measures.length = data.ws.length = data.fetches.length = data.longTasks.length = 0;
        data.mark = time();
        data.oldNodes = [...document.querySelectorAll('#pi-thinking-select option, #pi-mobile-thinking option, #pi-command-menu button, #pi-model-results .pi-model-option')];
    };
    window.batch4Snapshot = () => {
        const input = document.querySelector('#pi-input'), menu = document.querySelector('#pi-command-menu');
        const select = document.querySelector('#pi-thinking-select');
        const selectors = ['body', '.pi-workbench', '#pi-transcript', '#pi-transcript-content', '.pi-composer', '#pi-command-menu', '#pi-mobile-context-dialog', '#pi-model-dialog'];
        const geometry = Object.fromEntries(selectors.flatMap(selector => {
            const element = document.querySelector(selector); if (!element || !element.getClientRects().length) return [];
            const rect = element.getBoundingClientRect();
            return [[selector, { width: rect.width, client: element.clientWidth, scroll: element.scrollWidth, left: rect.left, right: rect.right }]];
        }));
        return {
            elapsedMs: time() - data.mark, calls: data.calls, dom: data.dom, measures: data.measures, ws: data.ws, fetches: data.fetches,
            longTasks: data.longTasks.filter(entry => entry.start >= data.mark),
            oldNodes: data.oldNodes?.length || 0, oldNodesConnected: data.oldNodes?.filter(node => node.isConnected).length || 0,
            geometry, viewport: { width: innerWidth, documentWidth: document.documentElement.scrollWidth },
            output: { draft: input.value, menuVisible: !menu.classList.contains('hidden'), menuText: menu.textContent, menuItems: menu.querySelectorAll('[data-completion]').length,
                thinking: select.value, thinkingLabel: select.selectedOptions[0]?.textContent, computedFont: getComputedStyle(select).font,
                labelWidth: select.style.getPropertyValue('--pi-thinking-label-width'), mobileThinking: document.querySelector('#pi-mobile-thinking').value,
                options: [...select.options].map(option => [option.value, option.textContent]), mobileOptions: [...document.querySelector('#pi-mobile-thinking').options].map(option => [option.value, option.textContent]) },
            scope: data.composer?.host.context().key, epoch: data.composer?.epoch
        };
    };
}

module.exports = { isolateEnvironment, createFixture, installInstrumentation };
