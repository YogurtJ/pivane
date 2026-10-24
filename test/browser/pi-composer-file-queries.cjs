'use strict';
// Functional gates exercise the real index/scripts. No benchmark or live backend.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const evidence = process.env.BATCH4_FRONTEND_QUERY_EVIDENCE;
const keep = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'DISPLAY', 'XDG_RUNTIME_DIR', 'PLAYWRIGHT_MODULE', 'CHROMIUM_PATH']);
for (const key of Object.keys(process.env)) if (!keep.has(key)) delete process.env[key];
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { BUILTINS } = require('../../server/pi-composer-service');
const root = path.resolve(__dirname, '../..');
const cwd = '/synthetic/composer-file-queries', otherCwd = '/synthetic/composer-file-other';
const sessions = [{ id: 'a', cwd }, { id: 'b', cwd }, { id: 'c', cwd: otherCwd }].map(session => ({ ...session, name: `Synthetic ${session.id}`, messageCount: 4 }));
const model = { provider: 'fixture', id: 'fixture', name: 'Synthetic', input: ['text', 'image'] };
const messages = [{ role: 'user', content: 'Synthetic question', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'read', name: 'read', arguments: { path: 'synthetic.txt' } }], timestamp: 2 },
    { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: [{ type: 'text', text: 'Synthetic tool output' }], timestamp: 3 },
    { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }], timestamp: 4 }];
const template = { name: 'fixture-template', scope: 'user', filePath: '/synthetic/prompts/fixture-template.md', content: 'Synthetic template', revision: '1', description: 'Synthetic template' };
const reads = [], sockets = [], commands = [], unexpected = [], results = [];
let server, wss, browser, base;
const wait = async (predicate, label) => {
    const deadline = Date.now() + 10000;
    while (!predicate()) { assert.ok(Date.now() < deadline, `Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function reply(socket, command, data = {}, error) {
    socket.send(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: !error, data, error }));
}
function release(read, fail = false) {
    if (read.released) return;
    read.released = true; read.failed = fail;
    if (fail) read.response.status(503).json({ error: `Synthetic query failure ${read.id}` });
    else read.response.json({ cwd: read.cwd, files: [{ path: 'src/button click.js' }, { path: `${read.query}/response-${read.id}.ts` }], truncated: false });
}
function instrument({ cwd }) {
    localStorage.setItem('pi.web.cwd', cwd); localStorage.setItem(`pi.web.session:${cwd}`, 'a');
    localStorage.setItem('pi.web.transcriptMode', 'full');
    const data = window.fixture = { attempts: 0, finishes: 0, shows: [], clicks: 0 };
    Object.defineProperty(window, 'PiComposerTools', { configurable: true, set(Class) {
        const files = Class.prototype.files, show = Class.prototype.show;
        Class.prototype.files = function(...args) {
            data.attempts++;
            return files.apply(this, args).finally(() => { data.finishes++; });
        };
        Class.prototype.show = function(items) {
            data.shows.push({ paths: items.map(item => item.file?.path), scope: this.host.context().key, connected: this.host.context().connected });
            return show.call(this, items);
        };
        Object.defineProperty(window, 'PiComposerTools', { configurable: true, value: class extends Class {
            constructor(...args) { super(...args); data.composer = this; }
        } });
    } });
    for (const [name, field] of [['PiEditorSuggestions', 'suggestions'], ['PiSessionWorkflows', 'workflows']]) Object.defineProperty(window, name, { configurable: true, set(Class) {
        Object.defineProperty(window, name, { configurable: true, value: class extends Class {
            constructor(...args) { super(...args); data[field] = this; }
        } });
    } });
    const Socket = window.WebSocket;
    window.WebSocket = class extends Socket {
        constructor(url, ...args) {
            const parsed = new URL(url, location.href);
            if (parsed.host !== location.host || parsed.pathname !== '/api/pi/ws') throw new Error('Blocked unknown WebSocket');
            super(url, ...args); data.socket = this;
        }
    };
}
async function open(width) {
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width, height: width === 393 ? 852 : 1000 }, isMobile: width === 393, hasTouch: width === 393, serviceWorkers: 'block' });
    await context.addInitScript(instrument, { cwd });
    const page = await context.newPage(), errors = [], network = [];
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === base) return route.continue();
        if (!['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) network.push(url.origin + url.pathname);
        return route.abort('blockedbyclient');
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => fixture.composer && fixture.composer.host.context().connected && !document.querySelector('#pi-input').disabled);
    const input = page.locator('#pi-input');
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const attempts = () => page.evaluate(() => fixture.attempts);
    const start = async query => {
        const before = reads.length, attempted = await attempts();
        await input.fill('@' + query);
        await page.waitForFunction(n => fixture.attempts > n, attempted);
        await wait(() => reads.length > before, 'new HTTP query');
        return reads.at(-1);
    };
    const click = async () => {
        const before = await attempts(); await input.dispatchEvent('click');
        await page.waitForFunction(n => fixture.attempts > n, before); await frame();
    };
    const finish = async (read, fail = false) => {
        const before = await page.evaluate(() => fixture.finishes);
        release(read, fail);
        await page.waitForFunction(n => fixture.finishes > n, before); await frame();
    };
    const hidden = () => page.locator('#pi-command-menu').evaluate(node => node.classList.contains('hidden'));
    const visible = async read => {
        await page.waitForFunction(id => !document.querySelector('#pi-command-menu').classList.contains('hidden') && document.querySelector('#pi-command-menu').textContent.includes(`response-${id}.ts`), read.id);
    };
    const switchSession = async id => {
        if (width === 393 && !await page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
        await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
        await page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && fixture.composer.host.context().connected, id);
    };
    return { context, page, input, frame, attempts, start, click, finish, hidden, visible, switchSession, errors, network };
}
async function checkCase(width, name, fn) {
    const before = reads.length, socketBefore = sockets.length;
    let h, row = { width, name };
    try {
        h = await open(width);
        await fn(h, row);
        const geometry = await h.page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
            overflow: ['body', '.pi-composer', '#pi-transcript-content', '#pi-command-menu'].filter(selector => { const n = document.querySelector(selector); return n.getClientRects().length && n.scrollWidth > n.clientWidth + 1; }) }));
        assert.equal(geometry.width, width); assert.ok(geometry.document <= width); assert.deepEqual(geometry.overflow, []);
        assert.deepEqual(h.errors, []); assert.deepEqual(h.network, []);
        row.geometry = geometry; row.status = 'passed';
    } catch (error) { row.status = 'failed'; row.error = error.stack || String(error); }
    finally {
        row.requests = reads.slice(before).map(({ response, ...read }) => read);
        if (h) {
            row.observed = await h.page.evaluate(() => ({ attempts: fixture.attempts, finishes: fixture.finishes, shows: fixture.shows, connected: fixture.composer.host.context().connected,
                draft: document.querySelector('#pi-input').value, menuHidden: document.querySelector('#pi-command-menu').classList.contains('hidden') })).catch(() => ({}));
            row.errors = h.errors; row.network = h.network;
            for (const read of reads.slice(before)) release(read);
            await h.context.close(); row.contextClosed = true;
        }
        row.sockets = sockets.slice(socketBefore).map(record => ({ id: record.id, sessionId: record.sessionId }));
        results.push(row); console.log(JSON.stringify(row));
    }
}
async function pendingSubmissionSlash(h, row, extension) {
    const original = extension ? '/fixture-command original argument' : 'ORIGINAL_SYNTHETIC_PROMPT';
    await h.input.fill(original); await h.page.locator('#pi-send-button').click();
    const socket = sockets.at(-1);
    await wait(() => socket.submission, 'original synthetic submission is held');
    await h.page.waitForFunction(() => fixture.composer.host.context().submitting);
    assert.equal(socket.submission.command.message, original);
    const promptCount = () => commands.filter(command => command.socket === socket.id && command.type === 'prompt').length;
    assert.equal(promptCount(), 1);
    await h.input.fill('/fixture-comm'); await h.frame();
    row.originalKind = extension ? 'extension' : 'prompt';
    row.menuHiddenWhileSubmitting = await h.hidden();
    assert.equal(row.menuHiddenWhileSubmitting, false, 'a pending previous submission must not suppress the new slash draft');
    await h.input.press('ArrowDown');
    assert.equal(await h.page.locator('#pi-command-menu [aria-selected="true"]').count(), 1);
    await h.input.press('Tab');
    assert.equal(await h.input.inputValue(), '/fixture-command ');
    assert.equal(await h.input.evaluate(node => node === document.activeElement), true);
    assert.equal(promptCount(), 1, 'choosing a slash candidate must not submit again');
    row.draftBeforeAcknowledgement = await h.input.inputValue();
    reply(socket.socket, socket.submission.command);
    await h.page.waitForFunction(() => !fixture.composer.host.context().submitting); await h.frame();
    row.draftAfterAcknowledgement = await h.input.inputValue(); row.promptCount = promptCount();
    assert.equal(row.draftAfterAcknowledgement, '/fixture-command ', 'the original acknowledgement must not consume the newer draft');
    assert.equal(row.promptCount, 1);
}
const cases = {
    async 'pending-prompt-allows-new-slash-completion'(h, row) { await pendingSubmissionSlash(h, row, false); },
    async 'pending-extension-allows-new-slash-completion'(h, row) { await pendingSubmissionSlash(h, row, true); },
    async 'same-scope-clicks-share-and-success-is-not-cached'(h, row) {
        const first = await h.start('same'), before = reads.length;
        await h.click(); await h.click();
        row.inFlightRequests = reads.length - before + 1;
        const pending = reads.slice(before - 1);
        for (const read of pending) release(read);
        await h.visible(pending.at(-1));
        assert.equal(row.inFlightRequests, 1, 'unchanged input plus two clicks must share one in-flight HTTP request');
        assert.equal(await h.page.evaluate(() => fixture.shows.length), 1, 'only newest caller renders');
        await h.click(); await wait(() => reads.length > before, 'new query after successful settlement');
        const second = reads.at(-1); await h.finish(second); await h.visible(second);
        assert.notEqual(second.id, first.id, 'successful result must not be cached');
        await h.input.press('ArrowDown'); await h.input.press('Enter');
        assert.equal(await h.input.inputValue(), '@"./src/button click.js" ');
        assert.equal(await h.input.evaluate(node => node === document.activeElement), true);
    },
    async 'same-scope-click-joins-before-pending-response-settles'(h, row) {
        const old = await h.start('settling'), before = reads.length;
        await h.input.dispatchEvent('click');
        await h.finish(old);
        row.menuHiddenAfterPendingResponse = await h.hidden();
        assert.equal(row.menuHiddenAfterPendingResponse, false, 'the newest unchanged click must receive the pending result even before another debounce expires');
        assert.ok((await h.page.locator('#pi-command-menu').textContent()).includes(`response-${old.id}.ts`));
        assert.equal(reads.length, before);
        assert.equal(await h.page.evaluate(() => fixture.shows.length), 1);
    },
    async 'disconnect-hides-old-result-preserves-draft-attachment-and-reconnects'(h, row) {
        await h.page.locator('#pi-file-input').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
        await h.page.locator('.pi-attachment-chip').waitFor();
        const old = await h.start('disconnect'), socket = sockets.at(-1);
        socket.socket.close(1012, 'Synthetic disconnect');
        await h.page.waitForFunction(() => !fixture.composer.host.context().connected);
        await h.finish(old);
        row.beforeReconnect = await h.page.evaluate(() => ({ connected: fixture.composer.host.context().connected, state: fixture.socket.readyState, showCount: fixture.shows.length, menuHidden: document.querySelector('#pi-command-menu').classList.contains('hidden') }));
        const failures = [];
        if (!row.beforeReconnect.menuHidden || row.beforeReconnect.showCount) failures.push('old file result displayed while disconnected');
        assert.equal(await h.input.inputValue(), '@disconnect'); assert.equal(await h.page.locator('.pi-attachment-chip').count(), 1);
        await h.page.waitForFunction(() => fixture.composer.host.context().connected);
        assert.ok(sockets.at(-1).id > socket.id);
        await h.click(); const current = reads.at(-1); await h.finish(current); await h.visible(current);
        assert.notEqual(current.id, old.id);
        assert.equal(await h.page.locator('[data-tool-id="read"]').getAttribute('data-state'), 'done');
        if (widthOf(h) === 393) {
            await h.page.locator('#pi-toggle-sessions').click();
            assert.equal(await h.page.locator('#pi-session-pane').evaluate(node => node.classList.contains('open')), true);
            await h.page.locator('#pi-toggle-sessions').click();
            await h.page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().right <= 0);
            assert.ok(await h.input.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16));
        }
        assert.deepEqual(failures, []);
    },
    async 'editor-A-B-A-before-B-debounce'(h) {
        const old = await h.start('alpha'), attempted = await h.attempts();
        await h.page.evaluate(() => { const input = document.querySelector('#pi-input'); for (const value of ['@beta', '@alpha']) { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent(new Event('input', { bubbles: true })); } });
        await h.page.waitForFunction(n => fixture.attempts > n, attempted); await h.frame();
        const current = reads.at(-1);
        assert.equal(current.query, 'alpha'); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'selection-A-B-A-invalidates-old-owner'(h) {
        const old = await h.start('selection'), attempted = await h.attempts();
        await h.input.evaluate(input => { input.setSelectionRange(0, 1); input.dispatchEvent(new Event('select')); input.setSelectionRange(input.value.length, input.value.length); input.dispatchEvent(new Event('select')); });
        await h.input.dispatchEvent('click');
        await h.page.waitForFunction(n => fixture.attempts > n, attempted); await h.frame();
        const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'input-activity-with-identical-value-invalidates'(h) {
        const old = await h.start('activity'), attempted = await h.attempts();
        await h.input.dispatchEvent('input');
        await h.page.waitForFunction(n => fixture.attempts > n, attempted); await h.frame();
        const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'programmatic-editor-A-B-A-observes-real-host-edits'(h) {
        const old = await h.start('programmatic');
        await h.page.evaluate(() => { fixture.suggestions.host.accept('@temporary', 'replace'); fixture.suggestions.host.accept('@programmatic', 'replace'); });
        await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'submission-version-alone-invalidates-await-continuation'(h) {
        const old = await h.start('version');
        await h.page.evaluate(() => fixture.workflows.host.commitDraft(fixture.workflows.host.getDraft()));
        await h.finish(old); assert.equal(await h.hidden(), true);
        assert.equal(await h.input.inputValue(), '@version');
        await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(current); await h.visible(current);
    },
    async 'submission-failure-does-not-restore-old-query-owner'(h) {
        const old = await h.start('submission');
        await h.page.locator('#pi-send-button').dispatchEvent('click');
        await wait(() => sockets.at(-1).submission, 'synthetic submitted message');
        const { command } = sockets.at(-1).submission;
        reply(sockets.at(-1).socket, command, null, 'Synthetic submission rejected');
        await h.page.waitForFunction(() => !document.querySelector('#pi-send-button').disabled);
        assert.equal(await h.input.inputValue(), '@submission');
        await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'blur-immediately-invalidates-file-query'(h) {
        const old = await h.start('blur');
        await h.page.locator('#pi-composer-add-button').focus();
        await h.finish(old);
        assert.equal(await h.hidden(), true, 'blur must cancel a pending response before its delayed visual dismissal');
        await h.input.focus(); await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(current); await h.visible(current);
    },
    async 'escape-cancels-query-before-menu-appears'(h) {
        const old = await h.start('escape'); await h.input.press('Escape');
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(current); await h.visible(current);
    },
    async 'template-editor-survives-disconnect-query-cancellation'(h, row) {
        const old = await h.start('template');
        await h.page.locator('#settings-manage-templates').evaluate(node => node.click());
        const dialog = h.page.locator('#pi-template-dialog'); await dialog.getByRole('button', { name: '编辑', exact: true }).click();
        await h.page.locator('#pi-template-content').fill('UNSAVED_SYNTHETIC_TEMPLATE');
        const socket = sockets.at(-1);
        socket.socket.close(1012, 'Synthetic disconnect in template editor');
        await h.page.waitForFunction(() => !fixture.composer.host.context().connected);
        await h.finish(old); assert.equal(await h.hidden(), true);
        assert.equal(await dialog.isVisible(), true);
        assert.equal(await h.page.locator('#pi-template-content').inputValue(), 'UNSAVED_SYNTHETIC_TEMPLATE');
        assert.equal(await h.input.inputValue(), '@template');
        row.disconnectTemplatePreserved = true;
        await h.page.waitForFunction(() => fixture.composer.host.context().connected);
        assert.ok(sockets.at(-1).id > socket.id);
        assert.equal(await dialog.isVisible(), false, 'existing automatic reconnect still resets the old template editor');
        assert.equal(await h.page.locator('#pi-template-content').count(), 0);
        assert.equal(await h.page.evaluate(() => fixture.composer.openKey === fixture.composer.host.context().key), false);
        assert.equal(await h.input.inputValue(), '@template');
        row.existingReconnectTemplateReset = true;
    },
    async 'session-A-B-A-keeps-new-owner'(h) {
        const old = await h.start('session'); await h.switchSession('b'); await h.switchSession('a');
        await h.input.focus(); await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current);
    },
    async 'cwd-A-B-A-keeps-new-owner'(h) {
        const old = await h.start('project');
        const project = async (projectCwd, id) => {
            await h.page.locator(widthOf(h) === 393 ? '#pi-mobile-summary' : '#pi-project-button').click();
            await h.page.locator(`#pi-project-list [data-cwd="${projectCwd}"]`).click(); await h.switchSession(id);
        };
        await project(otherCwd, 'c'); await project(cwd, 'a');
        await h.input.focus(); await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(old); assert.equal(await h.hidden(), true);
        await h.finish(current); await h.visible(current); assert.equal(current.cwd, cwd);
    },
    async 'old-finally-and-error-cannot-clear-new-record'(h) {
        const old = await h.start('old'), current = await h.start('current'), before = reads.length;
        await h.finish(old, true); await h.click();
        assert.equal(reads.length, before, 'old settled request must not evict the new shared request');
        assert.equal(await h.hidden(), true);
        assert.equal(await h.page.locator('#pi-toast-region').textContent().then(text => text.includes(`Synthetic query failure ${old.id}`)), false);
        await h.finish(current); await h.visible(current);
    },
    async 'failure-clears-record-without-automatic-replay'(h) {
        const old = await h.start('failure'), before = reads.length;
        await h.finish(old, true);
        await h.page.waitForFunction(id => document.querySelector('#pi-toast-region').textContent.includes(`Synthetic query failure ${id}`), old.id);
        await h.frame(); assert.equal(reads.length, before, 'failure is not automatically replayed');
        await h.click(); const current = reads.at(-1); assert.notEqual(current.id, old.id);
        await h.finish(current); await h.visible(current);
    },
    async 'await-rechecks-full-current-signature'(h) {
        const old = await h.start('caret');
        await h.input.evaluate(input => { input.value = 'prefix @caret suffix'; input.setSelectionRange(13, 14); });
        await h.finish(old); assert.equal(await h.hidden(), true);
        assert.equal(await h.input.inputValue(), 'prefix @caret suffix');
    },
    async 'command-completion-selection-keeps-menu-and-does-not-submit'(h) {
        const before = commands.filter(command => command.type === 'prompt').length;
        await h.input.fill('/fixture-command');
        await h.input.press('ArrowDown'); await h.input.press('Enter');
        assert.equal(await h.input.inputValue(), '/fixture-command ');
        assert.equal(commands.filter(command => command.type === 'prompt').length, before);
    },
    async 'IME-and-completion-keys-do-not-submit'(h) {
        const old = await h.start('keys'); await h.finish(old); await h.visible(old);
        const before = commands.filter(command => command.type === 'prompt').length;
        await h.input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
        assert.equal(await h.input.inputValue(), '@keys');
        await h.input.press('ArrowDown'); await h.input.press('Tab');
        assert.equal(await h.input.inputValue(), '@"./src/button click.js" ');
        assert.equal(commands.filter(command => command.type === 'prompt').length, before);
    }
};
function widthOf(h) { return h.page.viewportSize().width; }
(async () => {
    try {
        const app = express();
        app.use('/api', (req, res) => {
            const url = new URL(req.originalUrl, 'http://synthetic.invalid'), endpoint = url.pathname;
            const send = value => res.json(value);
            if (req.method !== 'GET') { unexpected.push({ method: req.method, endpoint }); return res.status(405).json({ error: 'Unexpected synthetic write' }); }
            if (endpoint === '/api/access/status') return send({ enabled: false, authenticated: true });
            if (endpoint === '/api/pi/status') return send({ ok: true, composerTools: true, projectRoots: ['/synthetic'] });
            if (endpoint === '/api/pi/projects') return send({ projects: [{ cwd, name: 'Synthetic', sessionCount: 2 }, { cwd: otherCwd, name: 'Other synthetic', sessionCount: 1 }], roots: ['/synthetic'] });
            if (endpoint === '/api/pi/sessions') return send({ sessions: sessions.filter(session => session.cwd === url.searchParams.get('cwd')) });
            if (endpoint === '/api/pi/activity') return send({ runtimes: [], pinnedProjects: [], hiddenProjects: [], replyNotices: [] });
            if (endpoint === '/api/pi/directories') return send({ cwd: '/synthetic', directories: [] });
            if (endpoint === '/api/pi/profiles') return send({ profiles: [] });
            if (endpoint === '/api/pi/settings/model-favorites') return send({ version: 1, revision: 1, favorites: [] });
            if (endpoint === '/api/pi/settings/updates/notifications') return send({ enabled: false, available: false, idle: true });
            if (endpoint === '/api/pi/composer/catalog') return send({ cwd: url.searchParams.get('cwd'), builtins: BUILTINS, templates: [template], warnings: [] });
            if (endpoint === '/api/pi/composer/template') return send(template);
            if (endpoint === '/api/pi/composer/files') { reads.push({ id: reads.length + 1, query: url.searchParams.get('q'), cwd: url.searchParams.get('cwd'), response: res, released: false }); return; }
            if (endpoint.endsWith('/workflow')) return send({ prompts: [], replies: [], versions: [], leafId: null });
            if (endpoint.endsWith('/deferred')) return send({ jobs: [] });
            if (endpoint === '/api/prompts' || endpoint.includes('history')) return send([]);
            unexpected.push({ method: req.method, endpoint }); return res.status(404).json({ error: 'Unknown synthetic endpoint' });
        });
        for (const [name, directory] of [['marked', 'marked/lib'], ['dompurify', 'dompurify/dist'], ['highlight', '@highlightjs/cdn-assets']]) app.use('/vendor/' + name, express.static(path.join(root, 'node_modules', directory)));
        app.use(express.static(path.join(root, 'public')));
        server = http.createServer(app); wss = new WebSocketServer({ server, path: '/api/pi/ws' });
        wss.on('connection', socket => {
            const record = { id: sockets.length + 1, socket }; sockets.push(record);
            socket.on('message', raw => {
                const command = JSON.parse(String(raw)); commands.push({ type: command.type, socket: record.id });
                if (command.type === 'open_session') { record.sessionId = command.sessionId; return reply(socket, command, { session: sessions.find(session => session.id === command.sessionId), state: { model, isStreaming: false, thinkingLevel: 'off' }, messages: { messages }, models: { models: [model] }, thinkingLevels: { levels: ['off', 'high'] }, commands: { commands: [{ name: 'fixture-command', source: 'extension', description: 'Synthetic command' }] }, stats: {} }); }
                if (command.type === 'get_state') return reply(socket, command, { model, isStreaming: false, thinkingLevel: 'off' });
                if (command.type === 'get_messages') return reply(socket, command, { messages });
                if (command.type === 'get_session_stats') return reply(socket, command, {});
                if (command.type === 'prompt') { record.submission = { command }; return; }
                unexpected.push({ rpc: command.type }); reply(socket, command, {});
            });
        });
        server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${server.address().port}`;
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env } });
        for (const width of [1440, 393]) for (const [name, fn] of Object.entries(cases)) await checkCase(width, name, fn);
        assert.deepEqual(unexpected, []);
        assert.deepEqual(results.filter(row => row.status !== 'passed').map(row => `${row.width}: ${row.name}: ${row.error}`), []);
    } catch (error) { console.error(error.stack || error); process.exitCode = 1; }
    finally {
        for (const read of reads) release(read);
        await browser?.close();
        if (wss) { for (const socket of wss.clients) socket.terminate(); await new Promise(resolve => wss.close(resolve)); }
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        const report = { exitCode: process.exitCode || 0, results, unexpected, cleanup: { browserClosed: true, serviceClosed: true, contextsClosed: results.every(row => row.contextClosed) } };
        if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'composer-file-queries.json'), JSON.stringify(report, null, 2) + '\n'); }
        console.log(JSON.stringify({ exitCode: report.exitCode, passed: results.filter(row => row.status === 'passed').length, total: results.length, cleanup: report.cleanup }));
    }
})();
