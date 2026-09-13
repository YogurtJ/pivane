const fs = require('node:fs');
function loadLocalEnv(envPath, env = process.env) {
    if (env.PI_MEDIA_PROFILE === 'clean' || !fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (!env[match[1]]) env[match[1]] = value;
    }
}
module.exports = { loadLocalEnv };
