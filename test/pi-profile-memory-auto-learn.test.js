'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewModelConfig } = require('../server/profile-memory/auto-learn');
const { ProfileMemoryConfiguration } = require('../server/profile-memory/config');

test('legacy reviewModel parses only for compatibility; managed workers never receive the old inline review route', async () => {
    assert.deepEqual(reviewModelConfig('{"provider":"synthetic","modelId":"cheap"}'), { provider: 'synthetic', modelId: 'cheap' });
    assert.equal(reviewModelConfig('{"provider":"synthetic"}'), null);
    assert.equal(reviewModelConfig('{"provider":"../bad","modelId":"cheap"}'), null);
    const config = new ProfileMemoryConfiguration();
    config.snapshot = async () => ({ bundlePath: '/synthetic/bundle', reviewModel: { provider: 'synthetic', modelId: 'cheap' },
        capability: { installed: true, autoLearn: true } });
    const env = await config.environment({ memory: { enabled: true, autoLearn: true }, skills: { learnedEnabled: true } });
    assert.equal(env.PIVANE_HERMES_BUNDLE, '/synthetic/bundle');
    assert.equal(env.PIVANE_PROFILE_MEMORY_REVIEW_MODEL, undefined);
});
