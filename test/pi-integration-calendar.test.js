const test = require('node:test');
const assert = require('node:assert/strict');

test('official subagent calendar uses installed Temporal for local dates and DST without scheduling a run', async () => {
    const calendar = await import('../vendor/pi-subagents/src/runs/background/calendar-schedule.js');
    const daily = calendar.normalizeCalendarRule({ every: 'day', at: '09:00', timezone: 'Asia/Taipei' });
    assert.deepEqual(calendar.nextCalendarOccurrence(daily, Date.parse('2026-10-14T00:00:00Z')), {
        nextLocalDate: '2026-10-14', nextRunAt: '2026-10-14T01:00:00.000Z'
    });
    const gap = calendar.normalizeCalendarRule({ every: 'day', at: '02:30', timezone: 'America/New_York' });
    assert.deepEqual(calendar.nextCalendarOccurrence(gap, Date.parse('2026-03-08T00:00:00Z')), {
        nextLocalDate: '2026-03-09', nextRunAt: '2026-03-09T06:30:00.000Z'
    }, 'nonexistent spring-forward time is skipped');
    const repeat = calendar.normalizeCalendarRule({ every: 'day', at: '01:30', timezone: 'America/New_York' });
    assert.equal(calendar.nextCalendarOccurrence(repeat, Date.parse('2026-11-01T00:00:00Z')).nextRunAt, '2026-11-01T05:30:00.000Z');
    assert.equal(calendar.nextCalendarOccurrence(repeat, Date.parse('2026-11-01T05:30:00Z')).nextLocalDate, '2026-11-02', 'repeated hour is consumed once');
    const weekly = calendar.normalizeCalendarRule({ every: 'week', on: ['fri', 'mon', 'fri'], at: '09:00', timezone: 'UTC' });
    assert.deepEqual(weekly.on, ['mon', 'fri']);
    const restored = calendar.restoreCalendarTrigger({ kind: 'calendar', ...weekly, nextLocalDate: '2026-10-16', nextRunAt: '2026-10-16T00:00:00Z' });
    assert.equal(restored.nextRunAt, '2026-10-16T09:00:00.000Z', 'restore recomputes local rule rather than trusting cached UTC');
    assert.deepEqual(calendar.latestCalendarOccurrence(weekly, Date.parse('2026-10-16T10:00:00Z'), '2026-10-14'), {
        nextLocalDate: '2026-10-16', nextRunAt: '2026-10-16T09:00:00.000Z'
    });
    assert.equal(calendar.calendarDateAfter(weekly, Date.parse('2026-10-16T10:00:00Z'), '2026-10-16'), '2026-10-17');
    assert.throws(() => calendar.normalizeCalendarRule({ every: 'day', at: '09:00', timezone: '+08:00' }), /IANA/);
});
