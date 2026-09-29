const test = require('node:test');
const assert = require('node:assert/strict');
const { nextTimes, parseCron } = require('../server/pi-cron-schedule');
test('cron uses explicit zones, ranges, weekdays and five-field validation', () => {
    const schedule = { kind: 'cron', expression: '0 17 * * *', timeZone: 'Asia/Shanghai' };
    assert.equal(new Date(nextTimes(schedule, Date.parse('2026-09-28T08:59:00Z'), 1)[0]).toISOString(), '2026-09-28T09:00:00.000Z');
    assert.throws(() => parseCron('0 0 25 * * *'));
    assert.throws(() => parseCron('60 * * * *'));
    assert.throws(() => parseCron('*/0 * * * *'));
    assert.throws(() => nextTimes({ ...schedule, timeZone: 'bad/zone' }));
    assert.deepEqual([...parseCron('*/15 9-17 * * 1-5').sets[0]], [0, 15, 30, 45]);
});
test('DST gaps skip, repeated local times run once, and leap days remain schedulable', () => {
    const gap = nextTimes({ kind: 'cron', expression: '30 2 * * *', timeZone: 'America/New_York' }, Date.parse('2026-03-08T00:00:00Z'), 1);
    assert.equal(new Date(gap[0]).toISOString(), '2026-03-09T06:30:00.000Z');
    const fold = { kind: 'cron', expression: '30 1 * * *', timeZone: 'America/New_York' };
    assert.equal(new Date(nextTimes(fold, Date.parse('2026-11-01T05:29:00Z'), 1)[0]).toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(new Date(nextTimes(fold, Date.parse('2026-11-01T05:31:00Z'), 1)[0]).toISOString(), '2026-11-02T06:30:00.000Z');
    assert.equal(new Date(nextTimes({ kind: 'cron', expression: '0 0 29 2 *', timeZone: 'UTC' }, Date.parse('2026-01-01'), 1)[0]).toISOString(), '2028-02-29T00:00:00.000Z');
});
