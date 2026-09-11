const assert = require('node:assert/strict');
const test = require('node:test');
const { buildFlux2Workflow } = require('../server/flux2-workflow');

test('builds the official Flux 2 Dev ComfyUI workflow with normalized controls', () => {
    const result = buildFlux2Workflow({ prompt: 'A precise product photo', width: 999, height: 1537, steps: 99, cfg: 12, seed: 42 });
    assert.equal(result.seed, 42);
    assert.equal(result.settings.width, 1024);
    assert.equal(result.settings.height, 1536);
    assert.equal(result.settings.steps, 50);
    assert.equal(result.settings.cfg, 10);
    assert.equal(result.workflow['38'].inputs.type, 'flux2');
    assert.equal(result.workflow['47'].class_type, 'EmptyFlux2LatentImage');
    assert.deepEqual(result.workflow['48'].inputs, { steps: 50, width: 1024, height: 1536 });
    assert.equal(result.workflow['9'].inputs.filename_prefix, 'Pi5_GUI/flux2_dev');
});
