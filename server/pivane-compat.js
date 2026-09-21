const fs = require('node:fs');
const path = require('node:path');

const INTERNAL_COMMAND = 'pivane-web-navigate';
const INTERNAL_COMMAND_PATTERN = '(?:pivane|pi5)-web-navigate';
const isInternalCommand = name => typeof name === 'string' && /^(?:pivane|pi5)-web-navigate(?::\d+)?$/.test(name);
const customTypeIs = (entry, current) => entry?.customType === current || entry?.customType === current.replace(/^pivane-/, 'pi5-');

// Existing installations keep their selected file until an explicit offline
// migration. A read must not copy state or start a second configuration store.
function dataFile(directory, current) {
    const preferred = path.join(directory, current), legacy = path.join(directory, current.replace(/^pivane-/, 'pi5-'));
    const present = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
    const hasCurrent = present(preferred), hasLegacy = present(legacy);
    if (hasCurrent && hasLegacy && preferred !== legacy) throw new Error(`Both current and legacy configuration exist: ${current}`);
    return hasLegacy ? legacy : preferred;
}

// Normalize only our private bridge keys. Unknown and late legacy replies are
// still intercepted, so old workers cannot leak private context after an update.
function privateReply(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
    for (const suffix of ['Models', 'Resources', 'TitleEligibility', 'Title', 'History', 'Context', 'Navigation']) {
        const legacy = `pi5${suffix}`, current = `pivane${suffix}`;
        if (Object.hasOwn(record, legacy) && typeof record[current] !== (suffix === 'TitleEligibility' ? 'boolean' : 'string')) record[current] = record[legacy];
    }
    return record;
}

module.exports = { INTERNAL_COMMAND, INTERNAL_COMMAND_PATTERN, isInternalCommand, customTypeIs, dataFile, privateReply };
