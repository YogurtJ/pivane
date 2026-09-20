const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require('../scripts/install-service.cjs');
const base = { root: '/tmp/Pivane space & name', home: '/tmp/user', node: '/opt/node/bin/node', executablePath: '/opt/node/bin:/usr/bin', url: 'http://127.0.0.1:3001/', desktop: '/tmp/Desktop', user: 'DOMAIN\\user' };
test('resident service plans bind the original managed launcher without embedding credentials', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
        const value = plan({ ...base, platform });
        assert.match(value.runnerText, /startManaged/); assert.match(value.runnerText, /process.env.PATH/);
        assert.ok(value.files.every(f => !f.content.includes('API_KEY')));
        assert.equal(value.id, plan({ ...base, platform }).id);
        if (platform === 'linux') { assert.match(value.files[0].content, /Restart=on-failure/); assert.match(value.files[0].content, /TimeoutStopSec=infinity/); }
        if (platform === 'darwin') { assert.match(value.files[0].content, /space &amp; name/); assert.ok(value.files.some(f => f.path.endsWith('.webloc'))); }
        if (platform === 'win32') { assert.match(value.files[0].content, /InteractiveToken/); assert.match(value.files[0].content, /PT0S/); assert.match(value.files[0].content, /AllowHardTerminate>false/); assert.ok(value.files.some(f => f.path.endsWith('.url'))); }
    }
});
test('service plans reject control characters and escape systemd specifiers', () => {
    assert.throws(() => plan({ ...base, platform: 'linux', root: '/tmp/x\nExecStart=bad' }), /control/);
    assert.match(plan({ ...base, platform: 'linux', root: '/tmp/100%' }).files[0].content, /100%%/);
    assert.throws(() => plan({ ...base, platform: 'other' }), /Supported/);
    assert.equal(plan({ ...base, platform: 'darwin', desktop: null }).files.length, 1);
});
