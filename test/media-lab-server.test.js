const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { buildFlux2Workflow } = require('../server/flux2-workflow');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');

test('isolated server preserves private adapter defaults, executes mock GPU/Flux/TTS through tickets, and separates media roots', { timeout: 30000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lab-server-'));
    const source = path.join(__dirname, '..'), appDir = path.join(root, 'app'), configDir = path.join(root, 'profile'), dataDir = path.join(root, 'data');
    fs.mkdirSync(appDir); fs.mkdirSync(configDir); fs.mkdirSync(dataDir);
    for (const name of ['server.js', 'server', 'config', 'native']) fs.cpSync(path.join(source, name), path.join(appDir, name), { recursive: true });
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(appDir, 'node_modules'));
    fs.mkdirSync(path.join(appDir, 'public/images'), { recursive: true });
    // The file service shares its pure path policy with the browser; include this code dependency in the isolated app.
    fs.copyFileSync(path.join(source, 'public/pi-file-policy.js'), path.join(appDir, 'public/pi-file-policy.js'));
    fs.copyFileSync(path.join(source, 'public/pi-file-policy.js'), path.join(appDir, 'public/pi-file-policy.js'));
    fs.writeFileSync(path.join(appDir, 'public/images', 'must-not-leak.png'), png);
    fs.writeFileSync(path.join(appDir, 'public', 'old.html.bak-test'), 'must not be served');
    const gpu = path.join(root, 'fixture-gpu.cjs');
    fs.writeFileSync(gpu, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = process.argv[2] || '';
if (command.includes('fixture payload')) process.exit(8);
let input = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  if (command === 'cat /dev/shm/.z/worker.ready') process.stdout.write(JSON.stringify({ status: 'ready', ts: Date.now() / 1000 }));
  else if (command.startsWith('cat > /dev/shm/.z/jobs/')) fs.writeFileSync(path.join(__dirname, 'last-job.json'), input);
  else if (command.endsWith('.done.json')) {
    const job = JSON.parse(fs.readFileSync(path.join(__dirname, 'last-job.json')));
    process.stdout.write(JSON.stringify({ ok: true, png: '/dev/shm/.z/out/' + job.id + '.png', seed: job.seed, w: job.w, h: job.h, steps: job.steps }));
  } else if (command.startsWith('base64 -w0 /dev/shm/.z/out/')) process.stdout.write('${png.toString('base64')}');
  else if (command.startsWith('rm -f /dev/shm/.z/out/')) {}
  else if (command.includes('/health')) process.stdout.write(JSON.stringify({ status: 'ok' }));
  else if (command.includes('/v1/audio/speech')) {
    const request = JSON.parse(input);
    if (request.text !== 'fixture payload') process.exit(9);
    process.stdout.write(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(44)]).toString('base64'));
  } else process.exit(7);
});
`, { mode: 0o700 });
    const originalImage = { id: 1, filename: 'old.png', imageUrl: '/images/old.png', prompt: 'Existing asset' };
    fs.writeFileSync(path.join(dataDir, 'generation_history.json'), JSON.stringify([originalImage]));
    fs.writeFileSync(path.join(configDir, 'profile.json'), JSON.stringify({ version: 1, gpuExec: gpu, image: {
        workerRoot: root, identity: 'fixture prefix', defaultLora: 'fixture-lora', defaultLoraStrength: 1.2, negative: 'fixture negative',
        defaultPreset: 'local', presets: { local: { label: 'Local fixture', width: 512, height: 768, steps: 20 } }
    } }));
    fs.writeFileSync(path.join(configDir, 'tts-providers.json'), JSON.stringify({ version: 1, defaultProvider: 'qwen-fixture', providers: [{ id: 'qwen-fixture', name: 'Qwen Fixture', adapter: 'qwen3-gpu', enabled: true,
        settings: { remoteRoot: '/fixture/qwen', healthUrl: 'http://127.0.0.1:8190/health', speechUrl: 'http://127.0.0.1:8190/v1/audio/speech', serviceSession: 'fixture', startupTimeoutMs: 1000, requestTimeoutMs: 3000 },
        models: [{ id: 'voice', name: 'Voice fixture', maxCharacters: 100, defaultVoice: 'voice-a', defaultLanguage: 'english', voices: [{ id: 'voice-a', name: 'A' }], languages: [{ id: 'english', name: 'English' }], controls: [{ id: 'instruct', label: 'Style', type: 'text', maxLength: 100, default: 'neutral' }] }]
    }] }));
    const comfyCalls = [];
    const objectInfo = Object.fromEntries(Object.values(buildFlux2Workflow({ prompt: 'fixture' }).workflow).map(node => [node.class_type, {}]));
    objectInfo.UNETLoader = { input: { required: { unet_name: [['flux2_dev_fp8mixed.safetensors']] } } };
    objectInfo.CLIPLoader = { input: { required: { clip_name: [['mistral_3_small_flux2_fp8.safetensors']] } } };
    objectInfo.VAELoader = { input: { required: { vae_name: [['flux2-vae.safetensors']] } } };
    const comfy = http.createServer(async (req, res) => {
        comfyCalls.push(req.url); res.setHeader('Content-Type', 'application/json');
        if (req.url === '/object_info') return res.end(JSON.stringify(objectInfo));
        if (req.url === '/prompt') {
            let raw = ''; for await (const chunk of req) raw += chunk;
            const body = JSON.parse(raw); assert.equal(body.prompt['6'].inputs.text, 'fixture flux');
            return res.end(JSON.stringify({ prompt_id: 'fixture-flux' }));
        }
        if (req.url === '/history/fixture-flux') return res.end(JSON.stringify({ 'fixture-flux': { outputs: { '9': { images: [{ filename: 'output.png' }] } } } }));
        if (req.url.startsWith('/view?')) { res.setHeader('Content-Type', 'image/png'); return res.end(png); }
        res.writeHead(404); res.end('{}');
    });
    comfy.listen(0, '127.0.0.1'); await once(comfy, 'listening');
    let output = '';
    const child = spawn(process.execPath, ['server.js'], { cwd: appDir, env: {
        PATH: process.env.PATH, HOME: process.env.HOME, HOST: '127.0.0.1', PORT: '0', PI_CODING_AGENT_DIR: path.join(root, 'agent'), PI_PROJECT_ROOTS: root,
        PI_MEDIA_CONFIG_DIR: configDir, PI_MEDIA_DATA_DIR: dataDir, PI_WEB_DEFERRED_FILE: path.join(root, 'queue.json'), PI_OFFLINE: '1',
        MINIMAX_API_KEY: 'fixture-not-a-secret', FLUX2_COMFY_BASE_URL: `http://127.0.0.1:${comfy.address().port}`
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
        comfy.closeAllConnections(); await new Promise(resolve => comfy.close(resolve)); fs.rmSync(root, { recursive: true, force: true });
    });
    // Port 0 is deliberately reported using the actual bound port by server.js.
    const deadline = Date.now() + 10000;
    while (!/running at http:\/\/localhost:\d+/.test(output) && Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(output);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    const port = output.match(/running at http:\/\/localhost:(\d+)/)?.[1]; assert.ok(port && port !== '0', output);
    const base = `http://127.0.0.1:${port}`;
    const post = async (endpoint, body) => {
        const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
    };
    const lab = await (await fetch(base + '/api/pi/media/lab')).json();
    assert.equal(lab.privateProfile, true);
    assert.equal(lab.models.some(model => ['zimage','flux2','minimax-video'].includes(model.adapter)), false);
    assert.equal((await fetch(base + '/images/must-not-leak.png')).status, 404);
    assert.equal((await fetch(base + '/old.html.bak-test')).status, 404);
    assert.equal((await fetch(base + '/api/media-agent/capabilities/all')).status, 200);
    const before = fs.readFileSync(path.join(dataDir, 'generation_history.json'), 'utf8');
    const review = await post('/api/pi/media/lab/review', { modelId: 'z-image-turbo', parameters: { prompt: 'fixture payload $(not-a-command)', seed: 8 } });
    assert.equal(review.model.parameters.loraStrength.default, 1.2); assert.equal(review.model.parameters.width.default, 512);
    assert.equal(review.model.configured, true);
    assert.equal(review.parameters.prompt, 'fixture prefix, fixture payload $(not-a-command)');
    assert.equal(fs.readFileSync(path.join(dataDir, 'generation_history.json'), 'utf8'), before);
    const generated = await post('/api/pi/media/lab/execute', { ticket: review.ticket, confirmed: true });
    assert.equal(generated.result.image.width, 512); assert.equal(generated.result.image.seed, 8);
    const job = JSON.parse(fs.readFileSync(path.join(root, 'last-job.json')));
    assert.equal(job.lora_weight, 1.2); assert.equal(job.lora_enabled, true);
    assert.equal(job.prompt, review.parameters.prompt);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, 'generation_history.json')))[0], originalImage);
    const flux = await post('/api/pi/media/lab/review', { modelId: 'flux-2-dev', parameters: { prompt: 'fixture flux', seed: 42 } });
    await post('/api/pi/media/lab/execute', { ticket: flux.ticket, confirmed: true });
    assert.equal(comfyCalls.filter(url => url === '/prompt').length, 1);
    assert.equal(comfyCalls[0], '/object_info');
    delete objectInfo.Flux2Scheduler;
    const invalidFlux = await post('/api/pi/media/lab/review', { modelId: 'flux-2-dev', parameters: { prompt: 'fixture flux' } });
    const blocked = await fetch(base + '/api/pi/media/lab/execute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: invalidFlux.ticket, confirmed: true }) });
    assert.equal(blocked.status, 500); assert.equal(comfyCalls.filter(url => url === '/prompt').length, 1);
    const speech = await post('/api/pi/media/lab/review', { modelId: 'tts:qwen-fixture:voice', parameters: { text: '  fixture payload  ' } });
    assert.equal(speech.parameters.text, 'fixture payload');
    const audio = await post('/api/pi/media/lab/execute', { ticket: speech.ticket, confirmed: true });
    assert.equal(audio.result.historyItem.text, 'fixture payload');
    assert.ok(fs.existsSync(path.join(dataDir, 'public/audio', audio.result.historyItem.filename)));
});
