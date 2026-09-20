const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { WorkspacePreferencesService } = require('../server/workspace-preferences-service');
const { UpdateNotifications, DAY } = require('../server/pi-update-notifications');

function fixture(t, lookup) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-update-notices-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const preferences = new WorkspacePreferencesService({ filePath: path.join(root, 'preferences.json') });
    preferences.writeDocument({ unrelated: { keep: true } });
    let now = 1000, calls = 0, idle = true, version = '0.86.0';
    const service = { piVersion: '0.85.1', pi: async () => { calls++; return lookup ? lookup() : { version }; } };
    const options = { preferences, service, now: () => now, idle: () => idle };
    const notices = new UpdateNotifications(options);
    return { notices, preferences, service, options, calls: () => calls, advance: ms => { now += ms; }, busy: () => { idle = false; }, idle: () => { idle = true; }, version: value => { version = value; } };
}

test('daily Pi checks coalesce, persist across restart, preserve unrelated preferences and never install', async t => {
    const f = fixture(t), first = f.notices.check();
    assert.equal(first, f.notices.check());
    const value = await first; assert.equal(value.available, true); assert.equal(f.calls(), 1);
    const restarted = new UpdateNotifications(f.options);
    await restarted.check(); assert.equal(f.calls(), 1);
    f.advance(DAY - 1); await restarted.check(); assert.equal(f.calls(), 1);
    f.advance(1); await restarted.check(); assert.equal(f.calls(), 2);
    assert.deepEqual(f.preferences.readDocument().unrelated, { keep: true });
    f.service.piVersion = '0.86.0'; assert.equal(restarted.snapshot().available, false);
});

test('network failures back off silently and disabling during a pending check survives completion', async t => {
    const failure = fixture(t, () => { throw new Error('private proxy credential'); });
    await failure.notices.check(); assert.equal(failure.calls(), 1);
    assert.ok(!JSON.stringify(failure.notices.snapshot()).includes('private'));
    failure.advance(3600000 - 1); await failure.notices.check(); assert.equal(failure.calls(), 1);
    failure.advance(1); await failure.notices.check(); assert.equal(failure.calls(), 2);
    failure.advance(3600000); await failure.notices.check(); assert.equal(failure.calls(), 2);
    let release;
    const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
    const pending = f.notices.check(); await Promise.resolve();
    f.notices.change({ enabled: false }); release({ version: '0.86.0' }); await pending;
    assert.equal(f.notices.snapshot().enabled, false); assert.equal(f.notices.snapshot().available, false);
    f.advance(10 * DAY); await f.notices.check(); assert.equal(f.calls(), 1);
    f.notices.change({ enabled: true }); assert.equal(f.notices.snapshot().available, true);
});

test('one instance-wide reminder per version, idle-only claims, three-day snooze and version-specific ignore', async t => {
    const f = fixture(t); await f.notices.check();
    const action = action => f.notices.change({ action, version: '0.86.0' });
    f.busy(); assert.equal(action('claim').claimed, false); assert.equal(f.notices.snapshot().eligible, true);
    f.idle(); assert.equal(action('claim').claimed, true); assert.equal(action('claim').claimed, false);
    action('snooze'); f.advance(3 * DAY - 1); assert.equal(f.notices.snapshot().eligible, false);
    f.advance(1); assert.equal(action('claim').claimed, true);
    action('ignore'); assert.equal(f.notices.snapshot().available, false);
    f.version('0.87.0'); await f.notices.check(); assert.equal(f.notices.snapshot().eligible, true);
    assert.throws(() => action('ignore'), { status: 409 });
    for (const value of [{}, [], { enabled: 'yes' }, { enabled: false, version: '0.87.0' }, { action: 'install', version: '0.87.0' }]) {
        assert.throws(() => f.notices.change(value), { status: 400 });
    }
});
