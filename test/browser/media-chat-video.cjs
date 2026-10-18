// Isolated browser regression: generic async video, ordered frame previews, retrieval after interruption.
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const { Response } = require('node-fetch');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { MediaReferences } = require('../../server/media-references');
const { MediaLabService } = require('../../server/media-lab-service');
const { MediaChatRequests } = require('../../server/media-chat-requests');
const { MediaHttpExecutor } = require('../../server/media-http-protocol');
const { normalizeModel } = require('../../server/media-provider-service');
const { saveExternalMedia } = require('../../server/media-lab-storage');
const { mountMediaRoutes } = require('../../server/routes/media');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=';
// A half-second 64px green H.264 fixture; no generation service or ffmpeg required at test time.
let mp4 = Buffer.from('AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAPBbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAAfQAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAux0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAAfQAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAH0AAAEAAABAAAAAAJkbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAwAAAAGABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACD21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAc9zdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFUxhdmM2MS4xOS4xMDEgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwDAPEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAA3YAAAAAAAAAAYc3R0cwAAAAAAAAABAAAADAAAAgAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAGhjdHRzAAAAAAAAAAsAAAABAAAEAAAAAAEAAAoAAAAAAQAABAAAAAABAAAAAAAAAAEAAAIAAAAAAQAACgAAAAABAAAEAAAAAAEAAAAAAAAAAQAAAgAAAAABAAAIAAAAAAIAAAIAAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAMAAAAAQAAAERzdHN6AAAAAAAAAAAAAAAMAAAC3AAAAA4AAAAMAAAADAAAAAwAAAAUAAAADgAAAAwAAAAMAAAAFAAAAA4AAAAMAAAAFHN0Y28AAAAAAAAAAQAAA/EAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYxLjcuMTAzAAAACGZyZWUAAAN+bWRhdAAAAq4GBf//qtxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0xIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDM6MHgxMTMgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTEgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0yIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MyBiX3B5cmFtaWQ9MiBiX2FkYXB0PTEgYl9iaWFzPTAgZGlyZWN0PTEgd2VpZ2h0Yj0xIG9wZW5fZ29wPTAgd2VpZ2h0cD0yIGtleWludD0yNTAga2V5aW50X21pbj0yNCBzY2VuZWN1dD00MCBpbnRyYV9yZWZyZXNoPTAgcmNfbG9va2FoZWFkPTQwIHJjPWNyZiBtYnRyZWU9MSBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBzdGVwPTQgaXBfcmF0aW89MS40MCBhcT0xOjEuMDAAgAAAACZliIQAO//+46v4FNGvoc9hzE2yUNGNPzxSPTYUNLTnUBLOor0B3wAAAApBmiRsQ3/+p4+IAAAACEGeQniF/wm5AAAACAGeYXRCvww4AAAACAGeY2pCvww5AAAAEEGaaEmoQWiZTAhn//6eLfEAAAAKQZ6GRREsL/8JuQAAAAgBnqV0Qr8MOQAAAAgBnqdqQr8MOAAAABBBmqtJqEFsmUwIV//+OI3AAAAACkGeyUUVLCv/DDkAAAAIAZ7qakK/DDg=', 'base64');
// The open Chromium build omits H.264. Keep the original fixture for capable
// browsers and exercise the same MP4/playback assertions with this 64px AV1 clip.
const av1Mp4 = Buffer.from('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', 'base64');
(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-video-browser-'));
    const provider = { baseUrl: 'http://mock.invalid/api', auth: { mode: 'none' }, downloadOrigins: [] };
    const model = normalizeModel({ id: 'fixture-video', name: '通用视频 · 模拟服务', kind: 'video', remoteModel: 'video', parameters: {
        prompt: { type: 'textarea', label: '视频要求', required: true }, first: { type: 'image', label: '首帧', role: 'first_frame' },
        last: { type: 'image', label: '尾帧', role: 'last_frame' }, clips: { type: 'video', label: '参考视频', multiple: true }
    }, http: { path: '/jobs', body: { input: { $params: true } },
        poll: { path: '/jobs/{id}', idPath: ['id'], statusPath: ['state'], pending: ['running'], succeeded: ['done'], failed: ['failed'] },
        response: { type: 'url', path: ['url'], mimeType: 'video/mp4' } } });
    const lab = new MediaLabService({ profile: { models: [] }, videoService: {}, ttsService: {},
        saveExternal: input => saveExternalMedia(root, input),
        providerService: { withExecution: async (_snapshot, operation) => operation({ provider, model, key: '' }), requestPreview: () => ({}) } });
    lab.models = async () => [{ ...model, id: 'media:fixture:video', adapter: 'http-provider', configured: true }];
    let posts = 0, failQuery = true, terminalFailure = false, plan;
    lab.httpExecutor = new MediaHttpExecutor({ fetch: async (url, request) => {
        if (request.method === 'POST') {
            posts++; const body = JSON.parse(request.body);
            assert.equal(body.input.first, 'data:image/png;base64,' + png); assert.equal(body.input.last, body.input.first);
            assert.equal(body.input.clips[0], 'data:video/mp4;base64,' + mp4.toString('base64'));
            return new Response(JSON.stringify({ id: 'job-' + posts }));
        }
        if (url.includes('/jobs/')) {
            if (terminalFailure) return new Response(JSON.stringify({ state: 'failed' }));
            if (failQuery) throw Error('Synthetic connection interruption');
            return new Response(JSON.stringify({ state: 'done', url: 'http://mock.invalid/api/out.mp4' }));
        }
        assert.ok(url.endsWith('/out.mp4')); return new Response(mp4);
    } });
    lab.references = new MediaReferences({ directory: root + '/refs' });
    lab.chatRequests = new MediaChatRequests({ lab, file: root + '/chat.json' });
    const app = express(); app.use(express.json({ limit: '32mb' }));
    const router = express.Router(); mountMediaRoutes(router, { mediaLabService: lab }); app.use('/api/pi', router);
    app.use('/videos', express.static(root + '/public/videos'));
    app.get('/', (_, res) => res.type('html').send(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/media-lab.css"><link rel="stylesheet" href="/pi-media-requests.css"><style>body{margin:0;padding:16px;box-sizing:border-box;display:block;overflow:auto}main{max-width:700px;margin:auto}*,*:before,*:after{box-sizing:border-box}</style><main id="chat"></main><script src="/media-fields.js"></script><script src="/pi-media-requests.js"></script><script>
const message=${JSON.stringify({ role: 'toolResult', toolName: 'media_generate', details: { plan } })};
const cards=PiMediaRequests.create({fetch:async(url,options)=>{const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error);return data;}});
document.querySelector('#chat').append(cards.render(message));
</script></html>`));
    app.use(express.static(path.join(__dirname, '../../public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening'); let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        const probe = await browser.newPage();
        const h264 = await probe.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.64000A"'));
        await probe.close();
        if (!h264) { mp4 = av1Mp4; console.log('MP4 playback fixture: AV1 (this browser does not decode H.264)'); }
        for (const width of [1440, 393, 320]) {
            const image = lab.references.put('data:image/png;base64,' + png).ref;
            const video = lab.references.put('data:video/mp4;base64,' + mp4.toString('base64')).ref;
            plan = await lab.plan({ modelId: 'media:fixture:video', summary: '从首帧过渡到尾帧 · 合成测试', parameters: { prompt: '镜头缓慢推进', first: image, last: image, clips: [video] } });
            failQuery = true; terminalFailure = false;
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500 });
            const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
            await page.addInitScript(() => {
                const original = window.setInterval;
                window.setInterval = (callback, ms, ...args) => { if (ms === 2500) window.mediaPoll = callback; return original(callback, ms, ...args); };
            });
            await page.goto('http://127.0.0.1:' + server.address().port, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => [...document.querySelectorAll('.pi-media-request-ref img')].filter(i => i.naturalWidth).length === 2);
            assert.deepEqual(await page.locator('.pi-media-request-ref figcaption').allTextContents(), ['首帧', '尾帧', '参考视频']);
            const before = posts;
            await page.getByRole('button', { name: '确认生成', exact: true }).click();
            await page.getByRole('button', { name: '继续查询原任务', exact: true }).waitFor();
            assert.equal(posts, before + 1);
            // A replacement journal simulates process restart. The browser can retrieve the original task.
            lab.chatRequests = new MediaChatRequests({ lab, file: root + '/chat.json' });
            await page.reload({ waitUntil: 'networkidle' });
            failQuery = false;
            await page.getByRole('button', { name: '继续查询原任务', exact: true }).click();
            await page.locator('.pi-media-request[data-state=done]').waitFor();
            await page.waitForFunction(() => document.querySelector('video.pi-media-request-media')?.videoWidth === 64).catch(async error => {
                console.error(JSON.stringify(await page.locator('video.pi-media-request-media').evaluateAll(nodes => nodes.map(video => ({ src: video.src, readyState: video.readyState, networkState: video.networkState, error: video.error?.message, width: video.videoWidth, connected: video.isConnected })))));
                throw error;
            });
            assert.equal(posts, before + 1, 'recovery must not POST a new video');
            assert.match(await page.locator('a[download]').getAttribute('href'), /^\/videos\//);
            // Keep a synthetic newer attempt running so finished video is refreshed by real status GETs.
            await page.route('**/api/pi/media/chat/requests?*', async route => {
                const response = await route.fetch(), data = await response.json();
                for (const state of Object.values(data.requests || {})) state.attempts.push({ id: 'synthetic-running', status: 'running', kind: 'video' });
                await route.fulfill({ response, json: data });
            });
            await page.reload({ waitUntil: 'networkidle' });
            await page.locator('.pi-media-request[data-state=running]').waitFor();
            await page.locator('video.pi-media-request-media').evaluate(async video => {
                window.finishedVideo = video; video.loop = true; window.playerDetaches = 0;
                new MutationObserver(records => {
                    for (const record of records) for (const node of record.removedNodes)
                        if (node === video || node.contains?.(video)) window.playerDetaches++;
                }).observe(document.body, { childList: true, subtree: true });
                await video.play();
            });
            await page.waitForFunction(() => document.querySelector('video.pi-media-request-media')?.currentTime > 0.05);
            const refreshed = page.waitForResponse(response => response.url().includes('/api/pi/media/chat/requests?'));
            await page.evaluate(() => window.mediaPoll()); await refreshed;
            await page.waitForTimeout(80);
            const playback = await page.evaluate(() => ({ same: finishedVideo === document.querySelector('video.pi-media-request-media'),
                paused: finishedVideo.paused, detaches: playerDetaches, currentTime: finishedVideo.currentTime }));
            assert.equal(playback.same, true); assert.equal(playback.paused, false); assert.equal(playback.detaches, 0);
            assert.ok(playback.currentTime > 0);
            await page.locator('video.pi-media-request-media').evaluate(video => video.pause());
            await page.unroute('**/api/pi/media/chat/requests?*');
            const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
                rows: [...document.querySelectorAll('.pi-media-request,.pi-media-request-refs,.pi-media-request-actions')].map(n => ({ width: n.clientWidth, scroll: n.scrollWidth })) }));
            assert.ok(metrics.scroll <= width, JSON.stringify(metrics)); for (const row of metrics.rows) assert.ok(row.scroll <= row.width + 1, JSON.stringify(metrics));
            assert.deepEqual(errors, []);
            if (process.env.PI_MEDIA_SCREENSHOT_DIR) { fs.mkdirSync(process.env.PI_MEDIA_SCREENSHOT_DIR, { recursive: true }); await page.screenshot({ path: path.join(process.env.PI_MEDIA_SCREENSHOT_DIR, 'chat-video-' + width + '.png') }); }
            terminalFailure = true;
            plan = await lab.plan({ modelId: 'media:fixture:video', summary: '服务明确失败 · 合成测试', parameters: { prompt: '终态测试', first: image, last: image, clips: [video] } });
            await page.reload({ waitUntil: 'networkidle' });
            await page.getByRole('button', { name: '确认生成', exact: true }).click();
            await page.locator('.pi-media-request[data-state=failed]').waitFor();
            assert.equal(posts, before + 2);
            assert.equal(await page.getByRole('button', { name: '继续查询原任务', exact: true }).count(), 0);
            assert.doesNotMatch(await page.locator('.pi-media-request').textContent(), /结果不确定|未提交给服务|没有开始生成/);
            assert.match(await page.locator('.pi-media-request').textContent(), /服务已确认生成失败或取消/);
            const stored = JSON.parse(fs.readFileSync(root + '/chat.json'));
            stored.find(row => row.key === plan.id).attempts[0].status = 'uncertain';
            fs.writeFileSync(root + '/chat.json', JSON.stringify(stored));
            lab.chatRequests = new MediaChatRequests({ lab, file: root + '/chat.json' });
            await page.reload({ waitUntil: 'networkidle' });
            await page.locator('.pi-media-request[data-state=failed]').waitFor();
            assert.equal(posts, before + 2, 'legacy terminal receipt must not resubmit');
            assert.deepEqual(errors, []);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            if (process.env.PI_MEDIA_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.PI_MEDIA_SCREENSHOT_DIR, 'chat-video-failed-' + width + '.png') });
            await page.getByRole('button', { name: '再生成一次', exact: true }).click();
            await page.getByRole('button', { name: '确认再生成（上次可能已计费）', exact: true }).waitFor();
            assert.equal(posts, before + 2, 'a confirmed provider failure still needs an explicit new-generation confirmation');
            await context.close(); console.log(JSON.stringify({ width, passed: true, submissions: posts, resumedWithoutResubmit: true, terminalFailure: true, legacyTerminalFailure: true }));
        }
    } finally {
        await browser?.close(); await lab.chatRequests.execution; server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
