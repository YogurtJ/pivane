const test = require('node:test');
const assert = require('node:assert/strict');

const { MediaAgentService } = require('../server/media-agent-service');

function createService() {
    const ttsProviderService = {
        getPublicConfig() {
            return {
                configured: true,
                defaultProvider: 'voice-test',
                providers: [{
                    id: 'voice-test',
                    name: 'Voice Test',
                    configured: true,
                    models: [{
                        id: 'voice-model',
                        name: 'Voice Model',
                        maxCharacters: 120,
                        defaultVoice: 'voice-a',
                        defaultLanguage: 'chinese',
                        voices: [{ id: 'voice-a', name: 'Voice A', options: { instruction: 'warm', cfgScale: 4 } }],
                        languages: [{ id: 'chinese', name: 'Chinese' }],
                        controls: [
                            { id: 'instruction', type: 'textarea', maxLength: 20, optional: false },
                            { id: 'cfgScale', type: 'number', min: 0.5, max: 6, default: 4 }
                        ]
                    }]
                }]
            };
        },
        resolveRequest(input) {
            if (!input.text) throw new Error('Text is required');
            if (input.text.length > 120) throw new Error('Text too long');
            const instruction = String(input.options?.instruction || 'warm');
            if (instruction.length > 20) throw new Error('Instruction too long');
            const cfgScale = Math.min(6, Math.max(0.5, Number(input.options?.cfgScale ?? 4)));
            return {
                provider: { id: 'voice-test' },
                model: { id: 'voice-model' },
                voice: { id: 'voice-a' },
                language: { id: 'chinese' },
                text: input.text,
                speed: Number(input.speed) || 1,
                options: { instruction, cfgScale }
            };
        }
    };
    return new MediaAgentService({
        imageConfig: {
            engine: 'test-image',
            models: ['z-image-turbo', 'flux-2-dev'],
            modelProfiles: {
                'z-image-turbo': { backend: 'gpu-zimage', width: 480, height: 832, steps: 28, cfg: 1, sampler: 'flowmatch', scheduler: 'flow', supportsLora: true },
                'flux-2-dev': { backend: 'comfyui', configured: false, width: 1024, height: 1024, steps: 20, cfg: 4, sampler: 'euler', scheduler: 'flux2', supportsLora: false }
            },
            defaultModel: 'z-image-turbo',
            loras: ['test.safetensors'],
            defaultLora: 'test.safetensors',
            defaultLoraStrength: 1
        },
        videoConfig: {
            defaults: {
                engine: 'MiniMax H3',
                models: [
                    { id: 'MiniMax-H3', name: 'MiniMax H3', resolutions: ['768P', '2K'], minDuration: 4, maxDuration: 15 },
                    { id: 'MiniMax-H3-Max', name: 'MiniMax H3 Max', resolutions: ['480P', '768P'], minDuration: 5, maxDuration: 15 }
                ],
                model: 'MiniMax-H3', resolution: '768P', duration: 5, ratio: 'adaptive',
                ratios: ['adaptive', '16:9', '9:16'], prompt: 'move'
            }
        },
        ttsProviderService
    });
}

test('normalizes image plans and expands prompt variants without generating media', () => {
    const service = createService();
    const plan = service.validatePlan('image', {
        summary: 'Three portraits',
        count: 3,
        prompt: 'portrait',
        promptVariants: ['close portrait', 'half body'],
        width: 487,
        height: 830,
        steps: 100,
        loraStrength: 4,
        seed: 10
    }, {});

    assert.equal(plan.kind, 'image');
    assert.equal(plan.jobs.length, 3);
    assert.deepEqual(plan.jobs.map(job => job.prompt), ['close portrait', 'half body', 'close portrait']);
    assert.equal(plan.jobs[0].width, 480);
    assert.equal(plan.jobs[0].height, 832);
    assert.equal(plan.jobs[0].steps, 60);
    assert.equal(plan.jobs[0].loraStrength, 1.5);
    assert.deepEqual(plan.jobs.map(job => job.seed), [10, 11, 12]);
    assert.equal(plan.execution.mode, 'manual');
    assert.match(plan.warnings[0], /批量执行队列尚未启用/);
});

test('uses Flux 2 Dev controls and disables the Z-Image LoRA', () => {
    const service = createService();
    const plan = service.validatePlan('image', {
        summary: 'Flux poster', model: 'flux-2-dev', prompt: 'A poster', width: 1000, height: 1500,
        steps: 80, cfg: 7.5, loraEnabled: true, loraName: 'test.safetensors'
    }, {});
    assert.equal(plan.jobs[0].model, 'flux-2-dev');
    assert.equal(plan.jobs[0].width, 1024);
    assert.equal(plan.jobs[0].height, 1472);
    assert.equal(plan.jobs[0].steps, 50);
    assert.equal(plan.jobs[0].cfg, 7.5);
    assert.equal(plan.jobs[0].sampler, 'euler');
    assert.equal(plan.jobs[0].scheduler, 'flux2');
    assert.equal(plan.jobs[0].loraEnabled, false);
    assert.match(plan.warnings[0], /ComfyUI/);
});

test('normalizes MiniMax H3 duration, resolution, and image ratio', () => {
    const service = createService();
    const textPlan = service.validatePlan('video', {
        summary: 'Camera move', prompt: 'turn and smile', model: 'MiniMax-H3', duration: 99, resolution: '2K', ratio: 'adaptive'
    }, { sourceImageSelected: false });
    assert.equal(textPlan.jobs[0].duration, 15);
    assert.equal(textPlan.jobs[0].resolution, '2K');
    assert.equal(textPlan.jobs[0].ratio, '16:9');
    assert.equal(textPlan.jobs[0].sourceImageSelected, false);
    assert.equal(textPlan.warnings.length, 0);

    const imagePlan = service.validatePlan('video', {
        summary: 'Fast image video', prompt: 'push in', model: 'MiniMax-H3-Max', duration: 4, resolution: '2K', ratio: '9:16'
    }, { sourceImageSelected: true, sourceImageUrl: '/images/source.png' });
    assert.equal(imagePlan.jobs[0].duration, 5);
    assert.equal(imagePlan.jobs[0].resolution, '768P');
    assert.equal(imagePlan.jobs[0].ratio, 'adaptive');
});

test('uses the dynamic TTS registry to validate provider controls', () => {
    const service = createService();
    const plan = service.validatePlan('tts', {
        summary: 'Warm speech',
        segments: ['first', 'second'],
        provider: 'voice-test',
        model: 'voice-model',
        voice: 'voice-a',
        language: 'chinese',
        speed: 1.2,
        instruction: 'friendly',
        cfgScale: 5
    }, {});

    assert.equal(plan.jobs.length, 2);
    assert.deepEqual(plan.jobs[0], {
        text: 'first', provider: 'voice-test', model: 'voice-model', voice: 'voice-a',
        language: 'chinese', speed: 1.2, options: { instruction: 'friendly', cfgScale: 5 }
    });
});
