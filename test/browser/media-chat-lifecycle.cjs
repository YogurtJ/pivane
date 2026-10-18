// Synthetic DOM/API only: detached cards, pending reads/writes, polling and player reuse.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const source = fs.readFileSync(path.join(__dirname, '../../public/pi-media-requests.js'), 'utf8');
// Four seconds of PCM WAV, supported without proprietary video codecs.
const wav = Buffer.alloc(44 + 8000 * 2 * 4);
wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 44; i < wav.length; i += 2) wav.writeInt16LE(Math.round(1000 * Math.sin((i - 44) * Math.PI * 440 / 8000)), i);

(async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
    const errors = [];
    try {
        for (const width of [1440, 393]) {
            const page = await browser.newPage({ viewport: { width, height: 900 } });
            page.on('pageerror', error => errors.push(error.message));
            await page.goto('about:blank');
            await page.addScriptTag({ content: source });
            await page.evaluate(() => {
                window.makeMessage = i => ({ role: 'toolResult', toolName: 'media_generate', details: { plan: {
                    id: `plan-00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, modelId: 'fixture', kind: 'video', parameters: { prompt: 'Synthetic ' + i }
                } } });
                window.reads = 0; window.posts = 0; window.pendingWrites = [];
                window.manager = PiMediaRequests.create({ fetch: async (url, options) => {
                    if (url.endsWith('/lab')) return new Promise(resolve => { window.catalogDone = resolve; });
                    if (options?.method === 'POST') { posts++; return new Promise(resolve => pendingWrites.push(resolve)); }
                    reads++;
                    return { requests: Object.fromEntries(new URL(url, 'http://fixture').searchParams.get('keys').split(',').map(key => [key, { attempts: [] }])) };
                } });
                window.weak = [];
                // Include pending catalog callbacks, open-editor promises and confirmed POSTs.
                // Neither catalog nor writes settle before GC.
                for (let i = 0; i < 200; i++) {
                    const node = manager.render(makeMessage(i)); document.body.append(node);
                    const buttons = [...node.querySelectorAll('button')];
                    buttons.find(button => button.textContent === '修改参数').click();
                    buttons.find(button => button.textContent === '确认生成').click();
                    node.remove(); weak.push(new WeakRef(node));
                }
            });
            await page.waitForTimeout(100);
            const cdp = await page.context().newCDPSession(page);
            await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage');
            const retained = await page.evaluate(() => ({ created: weak.length, retainedAfterGC: weak.filter(ref => ref.deref()).length,
                mounted: document.querySelectorAll('.pi-media-request').length, posts, reads }));
            assert.equal(retained.retainedAfterGC, 0, JSON.stringify(retained));
            assert.equal(retained.posts, 200); assert.equal(retained.reads, 0, 'unmounted queued reads are pruned before dispatch');
            await page.evaluate(() => {
                catalogDone({ models: [] });
                for (const done of pendingWrites) done({ state: { attempts: [] } });
                pendingWrites = [];
            });
            await page.waitForTimeout(50);
            assert.equal(await page.locator('.pi-media-request').count(), 0, 'late operations never re-register detached DOM');
            // After pending writes settle, remount must re-read the server journal.
            await page.evaluate(() => document.body.append(manager.render(makeMessage(0))));
            await page.waitForFunction(() => reads === 1);
            assert.equal(await page.evaluate(() => posts), 200);
            await page.evaluate(() => { document.body.replaceChildren(); manager.reset(); });
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ width, detachedCards: retained, lateOperationsReattached: 0, passed: true }));
            await page.close();
        }
        const page = await browser.newPage(); page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.pathname.startsWith('/audio/')) {
                const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range || '');
                const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : wav.length - 1;
                return route.fulfill({ status: range ? 206 : 200, contentType: 'audio/wav', body: wav.subarray(start, end + 1),
                    headers: { 'Accept-Ranges': 'bytes', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${wav.length}` } : {}) } });
            }
            if (url.pathname.startsWith('/videos/')) return route.fulfill({ status: 204 });
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' });
        });
        await page.goto('http://media-fixture.invalid/');
        await page.evaluate(() => {
            window.ticks = []; window.setInterval = fn => { ticks.push(fn); return ticks.length; }; window.clearInterval = () => {};
            window.pending = []; window.calls = 0; window.activeReads = 0; window.maxReads = 0;
        });
        await page.addScriptTag({ content: source });
        await page.evaluate(() => {
            const key = 'plan-00000000-0000-0000-0000-000000000001';
            window.state = { attempts: [
                { id: 'video', status: 'done', kind: 'video', asset: { kind: 'video', url: '/videos/synthetic.mp4' } },
                { id: 'audio', status: 'done', kind: 'tts', asset: { kind: 'tts', url: '/audio/synthetic.wav' } },
                { id: 'new', status: 'running', startedAt: new Date().toISOString() }
            ] };
            window.manager = PiMediaRequests.create({ fetch: async url => {
                if (url.endsWith('/lab')) return { models: [] };
                calls++; activeReads++; maxReads = Math.max(maxReads, activeReads);
                if (calls > 1) await new Promise(resolve => pending.push(resolve));
                activeReads--; return { requests: { [key]: structuredClone(state) } };
            } });
            document.body.append(manager.render({ role: 'toolResult', toolName: 'media_generate', details: { plan: {
                id: key, modelId: 'fixture', kind: 'video', parameters: { prompt: 'Synthetic' }
            } } }));
        });
        await page.waitForFunction(() => document.querySelector('video') && ticks.length);
        await page.evaluate(async () => {
            window.players = [...document.querySelectorAll('video,audio')]; window.detaches = 0;
            new MutationObserver(records => {
                for (const record of records) for (const node of record.removedNodes)
                    if (players.some(player => node === player || node.contains?.(player))) detaches++;
            }).observe(document.body, { childList: true, subtree: true });
            const audio = document.querySelector('audio'); audio.muted = true; audio.loop = true; await audio.play();
            await new Promise(resolve => { audio.addEventListener('seeked', resolve, { once: true }); audio.currentTime = 1.25; });
            window.audioPositionBeforePoll = audio.currentTime;
        });
        for (let i = 0; i < 4; i++) { await page.evaluate(() => ticks[0]()); await page.waitForTimeout(50); }
        const overlap = await page.evaluate(() => ({ calls, pending: pending.length, maxReads }));
        assert.deepEqual(overlap, { calls: 2, pending: 1, maxReads: 1 });
        await page.evaluate(() => pending.forEach(resolve => resolve())); await page.waitForTimeout(50);
        const playback = await page.evaluate(() => ({ samePlayers: players.every((node, index) => node === document.querySelectorAll('video,audio')[index]), detaches,
            audioPlaying: !document.querySelector('audio').paused && document.querySelector('audio').currentTime > 0.05,
            positionContinued: document.querySelector('audio').currentTime > audioPositionBeforePoll && audioPositionBeforePoll >= 1.25 }));
        if (!playback.positionContinued) console.error(JSON.stringify(await page.evaluate(() => ({ before: audioPositionBeforePoll, after: document.querySelector('audio').currentTime, duration: document.querySelector('audio').duration }))));
        assert.deepEqual(playback, { samePlayers: true, detaches: 0, audioPlaying: true, positionContinued: true });
        assert.deepEqual(errors, []);
        const positions = await page.evaluate(() => ({ before: audioPositionBeforePoll, after: document.querySelector('audio').currentTime }));
        console.log(JSON.stringify({ simulatedPollIntervals: 4, overlap, playback, positions, errors, passed: true }));
        await page.close();
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
