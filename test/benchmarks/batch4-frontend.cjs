#!/usr/bin/env node
'use strict';
// Real index + scripts, synthetic loopback HTTP/API/WS, fresh Chromium contexts.
// Usage: node test/benchmarks/batch4-frontend.cjs --out /private/artifacts --samples 7
const { isolateEnvironment, createFixture, installInstrumentation } = require('../helpers/batch4-frontend-fixture.cjs');
const environment = isolateEnvironment();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '../..');
const args = process.argv.slice(2);
function option(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; }
const out = option('--out');
const samples = Number(option('--samples', '7'));
const widths = option('--widths', '1440,393').split(',').map(Number);
assert.ok(out && path.isAbsolute(out), '--out must be an absolute private artifact directory');
assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 30);
assert.ok(widths.length && widths.every(width => [1440, 393].includes(width)));
fs.mkdirSync(out, { recursive: true });
const log = message => { console.log(message); fs.appendFileSync(path.join(out, 'run.log'), message + '\n'); };
const json = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
const report = { startedAt: new Date().toISOString(), environment, samples, widths, node: process.version,
    source: { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim() },
    conditions: { syntheticApiDelayMs: 900, browserCache: 'fresh context per width, warm within each series', cpuThrottle: false, transport: 'loopback HTTP + real WS; only file API responses delayed', timing: 'serial within lane; batch lanes may run concurrently; preliminary localization only', instrumentation: 'wrap production class methods and native DOM/canvas/WS/fetch; no caching or replacement algorithm', longTaskThresholdMs: 50 },
    runs: [], cleanup: {}, exitCode: null };
let fixture, browser;

async function stable(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(60); // Allow longtask observer delivery; excluded from handler timings.
}
async function readCount(predicate, label) {
    const deadline = performance.now() + 10000;
    while (!predicate()) { assert.ok(performance.now() < deadline, `Timeout: ${label}`); await delay(10); }
}
function distribution(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b), percentile = q => sorted[Math.ceil((sorted.length - 1) * q)];
    return { n: values.length, min: sorted[0], median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) };
}
function summary(rows) {
    return { samples: rows.length,
        wsHandlerMs: distribution(rows.flatMap(row => row.ws.filter(call => call.type !== 'response').map(call => call.ms))),
        pickerRenderMs: distribution(rows.flatMap(row => row.calls.filter(call => call.name === 'PiModelPicker.render').map(call => call.ms))),
        completeMs: distribution(rows.flatMap(row => row.calls.filter(call => call.name === 'PiComposerTools.complete').map(call => call.ms))),
        measureTextCalls: rows.map(row => row.measures.length),
        mobileReplacements: rows.map(row => row.dom.filter(call => call.id === 'pi-mobile-thinking').length),
        modelReplacements: rows.map(row => row.dom.filter(call => call.id === 'pi-model-results').length),
        commandReplacements: rows.map(row => row.dom.filter(call => call.id === 'pi-command-menu').length),
        longTaskMs: rows.flatMap(row => row.longTasks.map(task => task.ms)),
        requests: rows.map(row => row.requests?.length || 0),
        inputToVisibleMs: distribution(rows.map(row => row.visibleAtMs).filter(Number.isFinite)),
        lastInputToVisibleMs: distribution(rows.map(row => row.latestInputToVisibleMs).filter(Number.isFinite)) };
}
async function runWidth(width) {
    const context = await browser.newContext({ viewport: { width, height: width === 393 ? 852 : 1000 }, locale: 'zh-CN', isMobile: width === 393, hasTouch: width === 393, serviceWorkers: 'block' });
    const unknownNetwork = [], blockedFontNetwork = [], pageErrors = [], consoleErrors = [];
    const run = { width, scenarios: {}, boundaries: [], unknownNetwork, blockedFontNetwork, pageErrors, consoleErrors };
    report.runs.push(run);
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await context.addInitScript(installInstrumentation, { cwd: fixture.cwd, locale: 'zh-CN' });
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === fixture.base) return route.continue();
        if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) blockedFontNetwork.push({ origin: url.origin, path: url.pathname });
        else unknownNetwork.push({ kind: 'http', origin: url.origin, path: url.pathname });
        return route.abort('blockedbyclient');
    });
    // installInstrumentation guards the native WS constructor before connection;
    // all allowed WS frames travel through the real loopback synthetic server.
    const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
    const memory = async () => ({ dom: await cdp.send('Memory.getDOMCounters'), performance: (await cdp.send('Performance.getMetrics')).metrics.filter(row => ['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'LayoutCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration'].includes(row.name)) });
    const collect = async label => {
        await stable(page);
        const row = await page.evaluate(() => batch4Snapshot()); row.label = label;
        assert.equal(row.viewport.width, width);
        assert.ok(row.viewport.documentWidth <= width, `${label}: document overflow`);
        for (const [selector, metric] of Object.entries(row.geometry)) assert.ok(metric.scroll <= metric.client + 1, `${label} ${selector}: overflow ${JSON.stringify(metric)}`);
        assert.deepEqual(row.output.mobileOptions, row.output.options);
        assert.equal(row.output.mobileThinking, row.output.thinking);
        return row;
    };
    const begin = () => page.evaluate(() => batch4Begin());
    const eventSample = async (label, event, reconcile = false) => {
        await begin(); const prior = fixture.rpc.length;
        fixture.send({ ...event, batch4Sample: label });
        await page.waitForFunction(label => batch4.ws.some(call => call.sample === label), label);
        if (reconcile) {
            await readCount(() => fixture.rpc.slice(prior).some(call => call.type === 'get_state'), label);
            await page.waitForFunction(() => batch4.ws.some(call => call.command === 'get_state'));
        }
        return collect(label);
    };
    try {
        const startup = performance.now();
        await page.goto(fixture.base, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.batch4?.composer && !document.querySelector('#pi-input').disabled && document.querySelector('#pi-meta-id').textContent === 'a');
        await stable(page);
        run.startup = { readyMs: performance.now() - startup, ...(await page.evaluate(() => batch4Snapshot())), memory: await memory() };
        const input = page.locator('#pi-input');
        await input.fill('UNSENT_SYNTHETIC_DRAFT');
        // Preserve attachment/tool state during ordinary UI notifications.
        await page.locator('#pi-file-input').setInputFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic unsent attachment') });
        await page.locator('.pi-attachment-chip').waitFor();
        assert.equal(await page.locator('[data-tool-id="fixture-tool"]').getAttribute('data-state'), 'done');
        const scenarios = run.scenarios;
        for (const [name, event, reconcile] of [
            ['unchangedModelsClosed', { type: 'gateway_models', models: fixture.models }, false],
            ['unchangedRuntimeReconcile', { type: 'agent_settled' }, true]
        ]) {
            scenarios[name] = [];
            for (let i = 0; i < samples; i++) scenarios[name].push(await eventSample(`${name}-${i}`, event, reconcile));
        }
        scenarios.unchangedResize = [];
        for (let i = 0; i < samples; i++) {
            await begin();
            const dispatchMs = await page.evaluate(() => { const start = performance.now(); window.dispatchEvent(new Event('resize')); return performance.now() - start; });
            scenarios.unchangedResize.push({ ...(await collect(`unchangedResize-${i}`)), dispatchMs });
        }
        assert.equal(await input.inputValue(), 'UNSENT_SYNTHETIC_DRAFT');
        assert.equal(await page.locator('.pi-attachment-chip').count(), 1);
        await page.locator('.pi-attachment-chip > button').last().click();
        if (width === 393) {
            await page.locator('#pi-toggle-sessions').click();
            assert.equal(await page.locator('#pi-session-pane').evaluate(element => element.classList.contains('open')), true);
            await page.locator('#pi-toggle-sessions').click();
            await page.waitForFunction(() => document.querySelector('#pi-session-pane').getBoundingClientRect().right <= 0);
            assert.ok(await input.evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16));
            await page.locator('#pi-mobile-context-trigger').click();
            await page.locator('#pi-mobile-choose-model').click();
        } else await page.locator('#pi-model-select').click();
        await page.locator('.pi-model-all').click();
        assert.equal(await page.locator('#pi-model-results .pi-model-option').count(), 60);
        await page.locator('#pi-model-results .pi-model-option').nth(10).focus();
        scenarios.unchangedModelsOpen = [];
        for (let i = 0; i < samples; i++) {
            const row = await eventSample(`unchangedModelsOpen-${i}`, { type: 'gateway_models', models: fixture.models });
            assert.equal(await page.locator('#pi-model-results .pi-model-option').count(), 60);
            assert.equal(await page.locator(':focus').getAttribute('class'), 'pi-model-option');
            scenarios.unchangedModelsOpen.push(row);
        }
        await page.keyboard.press('Escape');
        await input.fill('/fixture-');
        await page.waitForFunction(() => document.querySelectorAll('#pi-command-menu [data-completion]').length === 80);
        scenarios.sameCommandClick = [];
        for (let i = 0; i < samples; i++) {
            await begin(); await input.dispatchEvent('click');
            const row = await collect(`sameCommandClick-${i}`);
            assert.equal(row.output.menuItems, 80); assert.equal(await page.locator('#pi-command-menu img').count(), 0);
            scenarios.sameCommandClick.push(row);
        }
        scenarios.unchangedCommands = [];
        for (let i = 0; i < samples; i++) scenarios.unchangedCommands.push(await eventSample(`unchangedCommands-${i}`, { type: 'gateway_commands', commands: fixture.commands }));
        await input.fill('');
        // Control and duplicate sequence use the same query/size/900ms response delay.
        for (const duplicate of [false, true]) {
            const name = duplicate ? 'fileRepeatedSameScope' : 'fileSingle';
            scenarios[name] = [];
            for (let i = 0; i < samples; i++) {
                await input.fill(''); await begin();
                const before = fixture.fileReads.length;
                await input.fill('@same');
                if (duplicate) {
                    await readCount(() => fixture.fileReads.length >= before + 1, `${name} first request`);
                    await page.waitForTimeout(80); await input.dispatchEvent('click');
                    // Fixed user actions also replay after a future sharing change:
                    // the second click does not wait for a duplicate network request.
                    await page.waitForTimeout(280); await input.dispatchEvent('click');
                }
                await page.waitForFunction(() => batch4.calls.some(call => call.name === 'PiComposerTools.show') && document.querySelector('#pi-command-menu').textContent.includes('@same/组件.ts'));
                const visibility = await page.evaluate(() => ({ visibleAtMs: performance.now() - batch4.mark,
                    latestInputToVisibleMs: performance.now() - batch4.calls.filter(call => call.name === 'PiComposerTools.complete').at(-1).at }));
                const row = { ...(await collect(`${name}-${i}`)), ...visibility, requests: fixture.fileReads.slice(before).map(read => ({ ...read })) };
                assert.equal(row.output.draft, '@same'); assert.equal(row.output.menuItems, 2);
                assert.ok(row.requests.length >= 1 && row.requests.length <= (duplicate ? 3 : 1));
                assert.equal(row.calls.filter(call => call.name === 'PiComposerTools.show').length, 1, 'only latest editor request may display');
                scenarios[name].push(row);
            }
        }
        // A changed editor token discards old results, including A -> B -> A text.
        const fileBoundary = async (label, action) => {
            await input.fill(''); await begin(); const before = fixture.fileReads.length;
            await action(before);
            const row = { ...(await collect(label)), requests: fixture.fileReads.slice(before).map(read => ({ ...read })) };
            const latest = row.requests.at(-1);
            if (['editor-A-B-A', 'session-A-B-A', 'cwd-A-B-A', 'disconnect-new-socket'].includes(label)) {
                assert.ok(row.output.menuText.includes(`batch4-response-${latest.id}.txt`), `${label}: newest response must own output`);
                for (const read of row.requests.slice(0, -1)) assert.equal(row.output.menuText.includes(`batch4-response-${read.id}.txt`), false, `${label}: old response absent`);
            }
            run.boundaries.push(row); return row;
        };
        await fileBoundary('editor-A-B-A', async before => {
            for (const [i, text] of ['@alpha', '@beta', '@alpha'].entries()) {
                await input.fill(text); await readCount(() => fixture.fileReads.length >= before + i + 1, 'editor A-B-A');
            }
            await page.waitForFunction(() => batch4.calls.some(call => call.name === 'PiComposerTools.show') && document.querySelector('#pi-command-menu').textContent.includes('@alpha/组件.ts'));
            assert.equal(await input.inputValue(), '@alpha');
        });
        await fileBoundary('newer-draft-discards-late-file', async before => {
            await input.fill('@old'); await readCount(() => fixture.fileReads.length > before, 'old request');
            await input.fill('NEWER_SYNTHETIC_DRAFT');
            await page.waitForTimeout(1000);
            assert.equal(await page.locator('#pi-command-menu').evaluate(element => element.classList.contains('hidden')), true);
            assert.equal(await input.inputValue(), 'NEWER_SYNTHETIC_DRAFT');
        });
        const switchSession = async id => {
            if (width === 393 && !await page.locator('#pi-session-pane').evaluate(element => element.classList.contains('open'))) await page.locator('#pi-toggle-sessions').click();
            await page.locator(`[data-session-id="${id}"] .pi-session-main`).click();
            await page.waitForFunction(id => document.querySelector('#pi-meta-id').textContent === id && !document.querySelector('#pi-input').disabled, id);
        };
        await fileBoundary('session-A-B-A', async before => {
            await input.fill('@scope'); await readCount(() => fixture.fileReads.length > before, 'session A request');
            await switchSession('b');
            await input.fill('@scope'); await readCount(() => fixture.fileReads.length > before + 1, 'session B request');
            await switchSession('a');
            await input.fill(''); await input.fill('@scope');
            await page.waitForFunction(() => batch4.calls.filter(call => call.name === 'PiComposerTools.show').length >= 1 && document.querySelector('#pi-command-menu').textContent.includes('@scope/组件.ts'));
            assert.equal(await page.locator('#pi-meta-id').textContent(), 'a');
        });
        await fileBoundary('cwd-A-B-A', async before => {
            await input.fill('@project'); await readCount(() => fixture.fileReads.length > before, 'project A request');
            await page.locator(width === 393 ? '#pi-mobile-summary' : '#pi-project-button').click();
            await page.locator(`#pi-project-list [data-cwd="${fixture.otherCwd}"]`).click();
            await page.waitForFunction(() => document.querySelector('#pi-project-path').textContent.includes('batch4-frontend-other'));
            // Project selection exposes the other project's existing session.
            await switchSession('c');
            await input.fill('@project'); await readCount(() => fixture.fileReads.length > before + 1, 'project B request');
            await page.locator(width === 393 ? '#pi-mobile-summary' : '#pi-project-button').click();
            await page.locator(`#pi-project-list [data-cwd="${fixture.cwd}"]`).click();
            await switchSession('a');
            await input.fill(''); await input.fill('@project');
            await page.waitForFunction(() => document.querySelector('#pi-command-menu').textContent.includes('@project/组件.ts') && !document.querySelector('#pi-command-menu').classList.contains('hidden'));
        });
        await fileBoundary('disconnect-new-socket', async before => {
            await input.fill('@reconnect'); await readCount(() => fixture.fileReads.length > before, 'pre-disconnect');
            const socketId = fixture.currentSocket().id;
            fixture.disconnect();
            await page.waitForTimeout(1050);
            run.disconnectedBeforeReconnect = await page.evaluate(() => ({ socketReadyState: batch4Socket.readyState, scope: batch4.composer.host.context().key,
                connected: batch4.composer.host.context().connected, menuVisible: !document.querySelector('#pi-command-menu').classList.contains('hidden'),
                showCalls: batch4.calls.filter(call => call.name === 'PiComposerTools.show') }));
            await readCount(() => fixture.currentSocket()?.id > socketId, 'new socket');
            await page.waitForFunction(() => window.batch4Socket.readyState === WebSocket.OPEN && !document.querySelector('#pi-input').disabled);
            await input.fill(''); await input.fill('@reconnect');
            await page.waitForFunction(() => !document.querySelector('#pi-command-menu').classList.contains('hidden') && document.querySelector('#pi-command-menu').textContent.includes('@reconnect/组件.ts'));
        });
        await fileBoundary('failure-then-explicit-retry', async before => {
            fixture.failNextFile(); await input.fill('@failure');
            await readCount(() => fixture.fileReads.length > before && fixture.fileReads.at(-1).end, 'failed file request');
            await page.waitForFunction(() => document.querySelector('#pi-toast-region').textContent.includes('Synthetic file query failure'));
            await input.dispatchEvent('click');
            await page.waitForFunction(() => !document.querySelector('#pi-command-menu').classList.contains('hidden') && document.querySelector('#pi-command-menu').textContent.includes('@failure/组件.ts'));
        });
        await input.fill('');
        for (const level of ['high', 'off']) {
            await begin();
            await page.evaluate(level => { const select = document.querySelector('#pi-thinking-select'); select.value = level; select.dispatchEvent(new Event('change')); }, level);
            await page.waitForFunction(level => document.querySelector('#pi-mobile-thinking').value === level && !document.querySelector('#pi-thinking-select').disabled, level);
            run.boundaries.push(await collect(`thinking-level-${level}`));
        }
        await begin();
        await page.evaluate(() => document.querySelector('[data-font-size="large"]').click());
        run.boundaries.push(await collect('font-size-large'));
        await begin();
        await page.evaluate(() => document.querySelector('[data-font-size="default"]').click());
        run.boundaries.push(await collect('font-size-default'));
        // Locale is frozen per document: reload with a new display preference.
        const priorLabel = await page.locator('#pi-thinking-select option').first().textContent();
        await page.evaluate(() => localStorage.setItem('pi.workspace.language', 'en'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => window.batch4?.composer && !document.querySelector('#pi-input').disabled);
        await stable(page);
        const english = await page.evaluate(() => batch4Snapshot()); english.label = 'locale-en-new-document';
        assert.equal(await page.evaluate(() => PiI18n.locale), 'en');
        assert.notEqual(english.output.options[0][1], priorLabel);
        assert.deepEqual(english.output.options, english.output.mobileOptions);
        run.boundaries.push(english);
        await begin();
        await page.evaluate(() => { document.querySelector('#pi-thinking-select').style.fontFamily = 'monospace'; window.dispatchEvent(new Event('resize')); });
        run.boundaries.push(await collect('font-family-monospace'));
        await begin();
        await page.evaluate(() => { document.querySelector('#pi-thinking-select').style.removeProperty('font-family'); window.dispatchEvent(new Event('resize')); });
        run.boundaries.push(await collect('font-family-restored'));
        run.finalMemory = await memory();
        await page.screenshot({ path: path.join(out, `frontend-${width}.png`) });
        run.summary = Object.fromEntries(Object.entries(scenarios).map(([name, rows]) => [name, summary(rows)]));
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(unknownNetwork, []);
        run.status = 'passed';
        log(JSON.stringify({ width, status: run.status, summary: run.summary }));
    } finally {
        json(`frontend-${width}.json`, run);
        await context.close();
        run.contextClosed = true;
    }
}

(async () => {
    try {
        fixture = await createFixture(root);
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env } });
        report.browser = browser.version();
        log(JSON.stringify({ startedAt: report.startedAt, node: report.node, browser: report.browser, source: report.source, samples, widths }));
        for (const width of widths) await runWidth(width);
        assert.deepEqual(fixture.unknown, [], 'fixture rejects unexpected API/RPC traffic');
        assert.equal(fixture.rpc.filter(call => ['prompt', 'steer', 'follow_up'].includes(call.type)).length, 0);
        report.exitCode = 0;
    } catch (error) {
        report.error = { message: error.message, stack: error.stack };
        report.exitCode = 1; log(error.stack || String(error));
        process.exitCode = 1;
    } finally {
        await browser?.close(); report.cleanup.browserClosed = true;
        await fixture?.close(); report.cleanup.serviceClosed = true;
        eventLoop.disable();
        report.driver = { memory: process.memoryUsage(), maxRssKiB: process.resourceUsage().maxRSS, eventLoopDelayMs: { mean: eventLoop.mean / 1e6, max: eventLoop.max / 1e6, p95: eventLoop.percentile(95) / 1e6 } };
        report.finishedAt = new Date().toISOString();
        if (fixture) json('service.json', { fileReads: fixture.fileReads, apiReads: fixture.apiReads, rpc: fixture.rpc, unknown: fixture.unknown });
        json('report.json', report);
        log(JSON.stringify({ exitCode: report.exitCode, cleanup: report.cleanup, output: out }));
    }
})();
