const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionMetadataCache } = require('../server/pi-session-metadata');

test('disposable metadata bounds entries and bytes, and drops oversized previews', () => {
    const cache = new SessionMetadataCache();
    for (let i = 0; i < 5010; i++) cache.put(String(i), { revision: 'revision', metadata: { firstMessage: 'short' } });
    assert.equal(cache.files.size, 5000);
    assert.equal(cache.files.has('0'), false);
    for (let i = 0; i < 40; i++) cache.put('large-' + i, { revision: 'revision', metadata: { firstMessage: 'x'.repeat(500000) } });
    assert.ok(cache.bytes <= 16 * 1024 * 1024);
    assert.ok(cache.files.size < 40);
    cache.put('oversize', { revision: 'revision', metadata: { firstMessage: 'x'.repeat(1024 * 1024) } });
    assert.equal(cache.files.has('oversize'), false);
    assert.equal(cache.bytes, [...cache.files.values()].reduce((sum, row) => sum + row.bytes, 0));
});
