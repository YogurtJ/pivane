const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TtsProviderService, validateRegistry } = require('../server/tts-provider-service');

function makeRegistry() {
    return {
        version: 1,
        defaultProvider: 'qwen-test',
        providers: [
            {
                id: 'qwen-test',
                name: 'Qwen Test',
                adapter: 'qwen3-gpu',
                enabled: true,
                description: 'test provider',
                documentation: 'docs/tts-providers/qwen-test.md',
                settings: {
                    remoteRoot: '/remote/qwen',
                    healthUrl: 'http://127.0.0.1:8190/health',
                    speechUrl: 'http://127.0.0.1:8190/v1/audio/speech',
                    serviceSession: 'qwen-test',
                    startupTimeoutMs: 1000,
                    requestTimeoutMs: 5000
                },
                models: [
                    {
                        id: 'qwen-model',
                        name: 'Qwen Model',
                        maxCharacters: 12,
                        defaultVoice: 'serena',
                        defaultLanguage: 'chinese',
                        voices: [{ id: 'serena', name: 'Serena' }],
                        languages: [{ id: 'chinese', name: 'Chinese' }],
                        controls: [{ id: 'instruct', type: 'text', label: 'Style', maxLength: 20 }]
                    }
                ]
            }
        ]
    };
}

function makeBreezeRegistry() {
    return {
        version: 1,
        defaultProvider: 'breeze-test',
        defaultRevision: 'breeze-test-default',
        providers: [
            {
                id: 'breeze-test',
                name: 'Breeze Test',
                adapter: 'breeze-gpu',
                enabled: true,
                documentation: 'docs/tts-providers/breeze-test.md',
                settings: {
                    remoteRoot: '/remote/breeze',
                    healthUrl: 'http://127.0.0.1:8240/health',
                    speechUrl: 'http://127.0.0.1:8240/v1/audio/speech',
                    startScript: '/remote/breeze/start.sh',
                    startupTimeoutMs: 1000,
                    requestTimeoutMs: 5000,
                    sampleRate: 24000,
                    fastMode: true,
                    maxChunkCharacters: 8,
                    maxCombinedCharacters: 32,
                    chunkPauseMs: 100
                },
                models: [
                    {
                        id: 'breeze-model',
                        name: 'Breeze Model',
                        maxCharacters: 100,
                        defaultVoice: 'companion',
                        defaultLanguage: 'chinese',
                        voices: [{
                            id: 'companion',
                            name: 'Fixture Seed 17',
                            options: { instruction: '清晰自然', cfgScale: 4, seed: 17 }
                        }],
                        languages: [
                            { id: 'chinese', name: 'Chinese' },
                            { id: 'english', name: 'English' }
                        ],
                        controls: [
                            { id: 'instruction', type: 'textarea', label: 'Instruction', maxLength: 20, optional: false },
                            { id: 'cfgScale', type: 'number', label: 'CFG', min: 0.5, max: 6, step: 0.5, default: 4 },
                            { id: 'seed', type: 'number', label: 'Seed', min: 0, max: 1000, step: 1, default: 17, integer: true }
                        ]
                    }
                ]
            }
        ]
    };
}

function createBreezeFixture() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-breeze-provider-'));
    const configDir = path.join(rootDir, 'config');
    const docsDir = path.join(rootDir, 'docs', 'tts-providers');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    const configPath = path.join(configDir, 'tts-providers.json');
    fs.writeFileSync(configPath, JSON.stringify(makeBreezeRegistry()));
    fs.writeFileSync(path.join(docsDir, 'breeze-test.md'), '# Breeze Test\n');
    const gpuExec = path.join(rootDir, 'fake-gpu-exec.js');
    fs.writeFileSync(gpuExec, `#!/usr/bin/env node
const command = process.argv[2] || '';
if (command.includes('/health')) {
  process.stdout.write(JSON.stringify({ status: 'ok', sample_rate: 24000 }));
} else if (command.includes('/v1/audio/speech')) {
  if (command.includes('测试语音') || command.includes('第一句') || command.includes('第二句') || command.includes('第三句') || command.includes('清晰自然')) process.exit(4);
  const chunks = [];
  process.stdin.on('data', chunk => chunks.push(chunk));
  process.stdin.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    for (const expected of ['name="text"', 'name="instruction"', '清晰自然', 'name="cfg_scale"', '\\r\\n4\\r\\n', 'name="seed"', '\\r\\n17\\r\\n']) {
      if (!body.includes(expected)) process.exit(5);
    }
    if (!/(测试语音|第一句测试|第二句测试|第三句测试)/.test(body)) process.exit(7);
    process.stdout.write(Buffer.alloc(4800).toString('base64'));
  });
} else {
  process.exit(6);
}
`);
    fs.chmodSync(gpuExec, 0o700);
    return { rootDir, configPath, gpuExec };
}

function createFixture() {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tts-provider-'));
    const configDir = path.join(rootDir, 'config');
    const docsDir = path.join(rootDir, 'docs', 'tts-providers');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(docsDir, { recursive: true });
    const configPath = path.join(configDir, 'tts-providers.json');
    fs.writeFileSync(configPath, JSON.stringify(makeRegistry()));
    fs.writeFileSync(path.join(docsDir, 'qwen-test.md'), '# Qwen Test\n');
    const gpuExec = path.join(rootDir, 'fake-gpu-exec.js');
    fs.writeFileSync(gpuExec, `#!/usr/bin/env node
const command = process.argv[2] || '';
if (command.includes('/health')) {
  process.stdout.write(JSON.stringify({ status: 'ok', speakers: ['serena'] }));
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const request = JSON.parse(input);
    if (request.text !== '测试语音' || request.speaker !== 'serena' || request.language !== 'chinese' || request.instruct !== '温和') process.exit(3);
    process.stdout.write(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(44)]).toString('base64'));
  });
}
`);
    fs.chmodSync(gpuExec, 0o700);
    return { rootDir, configPath, gpuExec };
}

test('validates and exposes sanitized TTS provider configuration', () => {
    const fixture = createFixture();
    try {
        const service = new TtsProviderService(fixture);
        const config = service.getPublicConfig();
        assert.equal(config.defaultProvider, 'qwen-test');
        assert.equal(config.providers[0].configured, true);
        assert.equal(config.providers[0].models[0].voices[0].id, 'serena');
        assert.equal('settings' in config.providers[0], false);
        assert.equal(service.getDocumentation('qwen-test'), '# Qwen Test\n');
        assert.throws(() => service.resolveRequest({ text: '1234567890123' }), /Maximum: 12/);
        assert.throws(() => service.resolveRequest({ text: 'ok', voice: 'missing' }), /Unsupported voice/);
        assert.throws(() => service.resolveRequest({ text: 'ok', language: 'english' }), /Unsupported language/);
    } finally {
        fs.rmSync(fixture.rootDir, { recursive: true, force: true });
    }
});

test('Qwen3 GPU adapter sends structured input over stdin and returns WAV', async () => {
    const fixture = createFixture();
    try {
        const service = new TtsProviderService(fixture);
        const result = await service.synthesize({
            text: '测试语音',
            provider: 'qwen-test',
            model: 'qwen-model',
            voice: 'serena',
            language: 'chinese',
            speed: 1,
            options: { instruct: '温和' }
        });
        assert.equal(result.mimeType, 'audio/wav');
        assert.equal(result.extension, 'wav');
        assert.equal(result.provider, 'qwen-test');
        assert.equal(result.audio.subarray(0, 4).toString('ascii'), 'RIFF');
    } finally {
        fs.rmSync(fixture.rootDir, { recursive: true, force: true });
    }
});

test('Breeze GPU adapter sends multipart over stdin and wraps PCM as WAV', async () => {
    const fixture = createBreezeFixture();
    try {
        const service = new TtsProviderService(fixture);
        const config = service.getPublicConfig();
        assert.equal(config.defaultProvider, 'breeze-test');
        assert.equal(config.defaultRevision, 'breeze-test-default');
        assert.deepEqual(config.providers[0].models[0].controls.map(control => control.type), ['textarea', 'number', 'number']);

        const resolved = service.resolveRequest({ text: '测试语音' });
        assert.deepEqual(resolved.options, { instruction: '清晰自然', cfgScale: 4, seed: 17 });
        assert.throws(() => service.resolveRequest({ text: '测试', options: { instruction: '', cfgScale: 4, seed: 17 } }), /Instruction is required/);
        assert.throws(() => service.resolveRequest({ text: '测试', options: { instruction: '灵动', cfgScale: 7, seed: 17 } }), /CFG must be a number between/);
        assert.throws(() => service.resolveRequest({ text: '测试', options: { instruction: '灵动', cfgScale: 4, seed: 1.5 } }), /Seed must be an integer/);

        const result = await service.synthesize({ text: '测试语音', speed: 1 });
        assert.equal(result.mimeType, 'audio/wav');
        assert.equal(result.extension, 'wav');
        assert.equal(result.provider, 'breeze-test');
        assert.equal(result.audio.subarray(0, 4).toString('ascii'), 'RIFF');
        assert.equal(result.audio.readUInt32LE(24), 24000);
        assert.equal(result.audio.readUInt16LE(22), 1);
        assert.equal(result.audio.readUInt16LE(34), 16);
        assert.deepEqual(result.options, { instruction: '清晰自然', cfgScale: 4, seed: 17 });
        assert.equal(result.extraInfo.fastMode, true);
        assert.equal(result.extraInfo.chunkCount, 1);
        assert.equal(result.extraInfo.audioDurationSeconds, 0.1);
        assert.ok(result.extraInfo.rtf >= 0);

        const longResult = await service.synthesize({
            text: '第一句测试。第二句测试。第三句测试。',
            speed: 1
        });
        assert.equal(longResult.extraInfo.chunkCount, 3);
        assert.deepEqual(longResult.extraInfo.chunkCharacters, [6, 6, 6]);
        assert.equal(longResult.extraInfo.chunkPauseMs, 100);
        assert.equal(longResult.extraInfo.audioDurationSeconds, 0.5);
        assert.match(longResult.warning, /自动分为 3 段/);
        assert.equal(longResult.audio.readUInt32LE(40), 24000);
    } finally {
        fs.rmSync(fixture.rootDir, { recursive: true, force: true });
    }
});

test('rejects duplicate provider ids', () => {
    const registry = makeRegistry();
    registry.providers.push(structuredClone(registry.providers[0]));
    assert.throws(() => validateRegistry(registry), /duplicate TTS provider id/);
});
