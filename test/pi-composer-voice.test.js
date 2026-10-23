const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');

function fixture() {
    const scope = { window: {}, globalThis: {}, Blob, Uint8Array, crypto: webcrypto,
        FileReader: class { readAsDataURL() { this.result = 'data:audio/wav;base64,AA=='; queueMicrotask(() => this.onload()); } } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/pi-composer-voice.js'), 'utf8'), scope);
    let context = { cwd: '/synthetic/a', key: 'a', generation: 1, connected: true, submitting: false, submissionVersion: 0 };
    let text = 'original', resolve, reject, requests = 0;
    const voice = Object.create(scope.window.PiComposerVoice.prototype);
    Object.assign(voice, { phase: 'recording', result: { value: '', hidden: true }, use: { hidden: true }, copy: { hidden: true }, bar: { hidden: false },
        status(message) { this.message = message; }, sync() {}, host: {
            context: () => ({ ...context }),
            api: () => { requests++; return new Promise((yes, no) => { resolve = yes; reject = no; }); },
            append: value => { if (!context.connected || context.submitting) return false; text += (text ? '\n\n' : '') + value; return true; }
        } });
    const origin = { ...context };
    return { voice, context, origin, setText: value => { text = value; }, text: () => text, requests: () => requests,
        resolve: value => resolve(value), reject: error => reject(error) };
}
const uploaded = () => new Promise(resolve => setImmediate(resolve));

test('PiComposerVoice appends a late transcript when the user only keeps typing', async () => {
    const f = fixture(), pending = f.voice.submit(new Blob(['pcm']), f.origin, 'synthetic', '1');
    await uploaded(); f.setText('new typing'); f.resolve({ text: 'spoken' }); await pending;
    assert.equal(f.text(), 'new typing\n\nspoken'); assert.equal(f.voice.result.value, '');
});

for (const boundary of ['accepted', 'uncertain', 'accepted then identical next draft']) {
    test(`PiComposerVoice retains a late transcript for manual use after ${boundary} submission`, async () => {
        const f = fixture(), pending = f.voice.submit(new Blob(['pcm']), f.origin, 'synthetic', '1');
        await uploaded(); f.context.submissionVersion++; f.context.submitting = false;
        f.setText(boundary.includes('identical') ? 'original' : 'next draft');
        f.resolve({ text: 'old recording' }); await pending;
        assert.equal(f.text(), boundary.includes('identical') ? 'original' : 'next draft');
        assert.equal(f.voice.result.value, 'old recording'); assert.equal(f.voice.result.hidden, false);
        assert.equal(f.voice.insert(), true); assert.match(f.text(), /\n\nold recording$/);
        assert.equal(f.voice.insert(), false, 'manual insertion consumes the result once');
    });
}

test('PiComposerVoice retains results across thread, connection and in-flight submission changes', async () => {
    for (const change of [f => { f.context.key = 'b'; }, f => { f.context.generation++; }, f => { f.context.submitting = true; }]) {
        const f = fixture(), pending = f.voice.submit(new Blob(['pcm']), f.origin, 'synthetic', '1');
        await uploaded(); change(f); f.resolve({ text: 'kept' }); await pending;
        assert.equal(f.text(), 'original'); assert.equal(f.voice.result.value, 'kept'); assert.equal(f.voice.result.hidden, false);
    }
});

test('PiComposerVoice does not duplicate an active transcription or replay a failed upload', async () => {
    const f = fixture(), pending = f.voice.submit(new Blob(['pcm']), f.origin, 'synthetic', '1');
    await uploaded(); await f.voice.submit(new Blob(['pcm']), f.origin, 'synthetic', '1');
    assert.equal(f.requests(), 1); f.reject(new Error('synthetic failure')); await pending;
    assert.equal(f.requests(), 1); assert.equal(f.voice.phase, 'idle'); assert.equal(f.voice.message, 'synthetic failure');
});
