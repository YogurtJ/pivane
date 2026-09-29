const formatters = new Map();
const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
function formatter(timeZone) {
    if (typeof timeZone !== 'string' || timeZone.length > 100) fail('Invalid time zone');
    if (!formatters.has(timeZone)) {
        try {
            const value = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
            if (formatters.size >= 64) formatters.clear();
            formatters.set(timeZone, value);
        } catch { fail('Invalid IANA time zone'); }
    }
    return formatters.get(timeZone);
}
function localParts(time, zone) {
    const fields = Object.fromEntries(formatter(zone).formatToParts(time).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
    return { ...fields, weekday: new Date(Date.UTC(fields.year, fields.month - 1, fields.day)).getUTCDay() };
}
function dayKey(time, zone) {
    const p = localParts(time, zone);
    return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
function parseCron(expression) {
    if (typeof expression !== 'string' || expression.length > 150) fail('Invalid cron expression');
    const fields = expression.trim().split(/\s+/);
    if (fields.length !== 5) fail('Use a five-field cron expression: minute hour day month weekday');
    const bounds = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
    const sets = fields.map((field, i) => {
        const [min, max] = bounds[i], values = new Set();
        for (const part of field.split(',')) {
            const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
            if (!match) fail('Invalid cron field');
            const step = Number(match[2] || 1);
            let [start, end] = match[1] === '*' ? [min, max] : match[1].split('-').map(Number);
            if (end === undefined) end = match[2] ? max : start;
            if (start < min || end > max || start > end || step < 1 || step > max + 1) fail('Cron field is out of range');
            for (let n = start; n <= end; n += step) values.add(i === 4 && n === 7 ? 0 : n);
        }
        return values;
    });
    return { fields, sets, expression: fields.join(' ') };
}
function matchesDay(cron, p) {
    const [,, days, months, weekdays] = cron.sets;
    if (!months.has(p.month)) return false;
    const d = days.has(p.day), w = weekdays.has(p.weekday);
    return cron.fields[2].startsWith('*') ? w : cron.fields[4].startsWith('*') ? d : d || w;
}
// Resolve local wall time with the offsets around that date. Gaps produce no
// instant; folds choose the earliest instant, so an autumn clock change cannot
// send a greeting twice. No machine-local timezone is consulted.
function wallInstant(p, hour, minute, zone) {
    const wall = Date.UTC(p.year, p.month - 1, p.day, hour, minute);
    const offsets = new Set();
    for (const delta of [-36, 0, 36]) {
        const sample = wall + delta * 3600000, local = localParts(sample, zone);
        offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample);
    }
    const matches = [];
    for (const offset of offsets) {
        const instant = wall - offset, local = localParts(instant, zone);
        if (local.year === p.year && local.month === p.month && local.day === p.day && local.hour === hour && local.minute === minute) matches.push(instant);
    }
    return matches.length ? Math.min(...matches) : null;
}
function nextTimes(schedule, after = Date.now(), count = 5) {
    if (!Number.isFinite(after) || !Number.isInteger(count) || count < 1 || count > 5) fail('Invalid preview');
    formatter(schedule?.timeZone);
    if (schedule.kind === 'once') {
        if (!Number.isFinite(schedule.at)) fail('Invalid execution time');
        return schedule.at > after ? [schedule.at] : [];
    }
    if (schedule.kind !== 'cron') fail('Invalid schedule kind');
    const cron = parseCron(schedule.expression), first = localParts(after, schedule.timeZone), result = [];
    const hours = [...cron.sets[1]].sort((a, b) => a - b), minutes = [...cron.sets[0]].sort((a, b) => a - b);
    const start = Date.UTC(first.year, first.month - 1, first.day);
    for (let day = 0; day <= 366 * 8 && result.length < count; day++) {
        const date = new Date(start + day * 86400000);
        const p = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
        if (!matchesDay(cron, p)) continue;
        for (const hour of hours) {
            for (const minute of minutes) {
                if (day === 0 && (hour < first.hour || hour === first.hour && minute < first.minute)) continue;
                const instant = wallInstant(p, hour, minute, schedule.timeZone);
                if (instant !== null && instant > after) result.push(instant);
                if (result.length === count) return result;
            }
        }
    }
    return result;
}
function latestTime(schedule, after, before, graceMinutes) {
    if (schedule.kind === 'once') return schedule.at > after && schedule.at <= before ? schedule.at : null;
    const cron = parseCron(schedule.expression);
    const floor = Math.max(after, before - graceMinutes * 60000);
    for (let instant = Math.floor(before / 60000) * 60000; instant > floor; instant -= 60000) {
        const p = localParts(instant, schedule.timeZone);
        if (cron.sets[0].has(p.minute) && cron.sets[1].has(p.hour) && matchesDay(cron, p)
            && wallInstant(p, p.hour, p.minute, schedule.timeZone) === instant) return instant;
    }
    return null;
}
module.exports = { parseCron, localParts, dayKey, nextTimes, latestTime };
