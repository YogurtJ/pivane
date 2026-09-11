function boundedNumber(value, fallback, min, max, integer = false, step = 0) {
    const parsed = Number(value);
    let number = Number.isFinite(parsed) ? parsed : fallback;
    number = Math.min(max, Math.max(min, number));
    if (integer) number = Math.round(number);
    if (step) number = Math.round(number / step) * step;
    return Math.min(max, Math.max(min, number));
}

function buildFlux2Workflow(input = {}, files = {}) {
    const prompt = String(input.prompt || '').replace(/\r\n/g, '\n').trim().slice(0, 3000);
    if (!prompt) throw new Error('请先写 Flux 2 Dev 提示词');
    const width = boundedNumber(input.width, 1024, 256, 2048, true, 64);
    const height = boundedNumber(input.height, 1024, 256, 2048, true, 64);
    const steps = boundedNumber(input.steps, 20, 4, 50, true);
    const guidance = boundedNumber(input.cfg ?? input.guidance, 4, 1, 10);
    const seedValue = Number(input.seed);
    const seed = Number.isFinite(seedValue) && seedValue >= 0
        ? Math.floor(seedValue)
        : Math.floor(Math.random() * 1_000_000_000_000_000);
    const diffusionModel = files.diffusionModel || 'flux2_dev_fp8mixed.safetensors';
    const textEncoder = files.textEncoder || 'mistral_3_small_flux2_fp8.safetensors';
    const vae = files.vae || 'flux2-vae.safetensors';

    return {
        seed,
        settings: {
            model: 'flux-2-dev',
            engine: 'Flux 2 Dev FP8 (ComfyUI)',
            prompt,
            width,
            height,
            steps,
            cfg: guidance,
            sampler: 'euler',
            scheduler: 'flux2',
            diffusionModel,
            textEncoder,
            vae
        },
        workflow: {
            '6': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['38', 0] } },
            '8': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['10', 0] } },
            '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'Pi5_GUI/flux2_dev', images: ['8', 0] } },
            '10': { class_type: 'VAELoader', inputs: { vae_name: vae } },
            '12': { class_type: 'UNETLoader', inputs: { unet_name: diffusionModel, weight_dtype: 'default' } },
            '13': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['25', 0], guider: ['22', 0], sampler: ['16', 0], sigmas: ['48', 0], latent_image: ['47', 0] } },
            '16': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } },
            '22': { class_type: 'BasicGuider', inputs: { model: ['12', 0], conditioning: ['26', 0] } },
            '25': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
            '26': { class_type: 'FluxGuidance', inputs: { guidance, conditioning: ['6', 0] } },
            '38': { class_type: 'CLIPLoader', inputs: { clip_name: textEncoder, type: 'flux2', device: 'default' } },
            '47': { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: 1 } },
            '48': { class_type: 'Flux2Scheduler', inputs: { steps, width, height } }
        }
    };
}

module.exports = {
    buildFlux2Workflow
};
