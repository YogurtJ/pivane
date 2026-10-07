const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { once } = require('node:events');
const express = require('express');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { MediaReferences } = require('../../server/media-references');
const { MediaLabService } = require('../../server/media-lab-service');
const { MediaChatRequests } = require('../../server/media-chat-requests');
const { mountMediaRoutes } = require('../../server/routes/media');
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8AARGDiPwMAHfAD/aAzCYkAAAAASUVORK5CYII=';

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-chat-browser-'));
    const lab = new MediaLabService({ profile: { models: [], privateProfile: false }, videoService: {}, ttsService: {} });
    const model = { id: 'fixture-edit', name: 'Image edit fixture', kind: 'image', adapter: 'http-json', configured: true,
        parameters: { prompt: { type: 'textarea', label: '修改要求', required: true }, image: { type: 'image', label: '参考图片', required: true } } };
    lab.models = async () => [model];
    let count = 0;
    lab.executeHttp = async (_model, parameters) => {
        assert.match(parameters.image, /^data:image\/png;base64,/); count++;
        return { asset: { url: '/images/result.png', kind: 'image' } };
    };
    lab.references = new MediaReferences({ directory: path.join(root, 'refs') });
    lab.chatRequests = new MediaChatRequests({ lab, file: path.join(root, 'chat.json') });
    const app = express(); app.use(express.json({ limit: '32mb' }));
    const router = express.Router(); mountMediaRoutes(router, { mediaLabService: lab }); app.use('/api/pi', router);
    app.get('/images/result.png', (_, res) => res.type('png').send(Buffer.from(png, 'base64')));
    let plan;
    app.get('/', (_, res) => res.type('html').send(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/media-lab.css"><link rel="stylesheet" href="/pi-media-requests.css"><style>body{margin:0;padding:16px;box-sizing:border-box;display:block;overflow:auto}main{max-width:700px;margin:auto}*,*:before,*:after{box-sizing:border-box}</style><main id="chat"></main><script src="/media-fields.js"></script><script src="/pi-media-requests.js"></script><script>
const message=${JSON.stringify({ role: 'toolResult', toolName: 'media_generate', details: { plan } })};
const cards=PiMediaRequests.create({fetch:async(url,options)=>{const res=await fetch(url,options);const data=await res.json();if(!res.ok)throw new Error(data.error);return data;}});
function render(){document.querySelector('#chat').replaceChildren(cards.render(message));}render();
</script></html>`));
    app.use(express.static(path.join(__dirname, '../../public')));
    const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let browser;
    try {
        browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
        for (const width of [1440, 393, 320]) {
            const ref = lab.references.put('data:image/png;base64,' + png).ref;
            plan = await lab.plan({ modelId: model.id, summary: '修改照片背景', parameters: { prompt: '保留主体，把背景改成蓝色', image: ref } });
            const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 500 });
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: 'networkidle' });
            await page.waitForFunction(() => document.querySelector('.pi-media-request-ref img')?.naturalWidth > 0);
            const before = count;
            await page.getByRole('button', { name: '修改参数', exact: true }).click();
            await page.waitForFunction(() => document.querySelector('.lab-reference-slot img')?.naturalWidth > 0);
            await page.getByLabel('修改要求', { exact: true }).fill('保留主体，把背景改成绿色');
            await page.locator('input[type=file]').setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
            assert.equal(count, before, 'editing and previews must not generate');
            await page.getByRole('button', { name: '确认生成', exact: true }).click();
            await page.locator('.pi-media-request[data-state=done]').waitFor();
            assert.equal(count, before + 1);
            await page.reload({ waitUntil: 'networkidle' });
            await page.locator('.pi-media-request[data-state=done]').waitFor();
            await page.waitForFunction(() => document.querySelector('.pi-media-request-ref img')?.naturalWidth > 0);
            assert.equal(count, before + 1, 'reload must not replay generation');
            const metrics = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
                cards: [...document.querySelectorAll('.pi-media-request,.pi-media-request-refs')].map(node => ({ width: node.clientWidth, scroll: node.scrollWidth })) }));
            assert.ok(metrics.scroll <= width, JSON.stringify(metrics));
            for (const item of metrics.cards) assert.ok(item.scroll <= item.width + 1, JSON.stringify(metrics));
            assert.deepEqual(errors, []);
            if (process.env.PI_MEDIA_SCREENSHOT_DIR) {
                fs.mkdirSync(process.env.PI_MEDIA_SCREENSHOT_DIR, { recursive: true });
                await page.screenshot({ path: path.join(process.env.PI_MEDIA_SCREENSHOT_DIR, `chat-reference-${width}.png`) });
            }
            await context.close(); console.log(JSON.stringify({ width, passed: true, generations: count }));
        }
    } finally {
        await browser?.close(); await lab.chatRequests.execution;
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
