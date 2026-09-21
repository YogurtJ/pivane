const fs = require('node:fs');

// Pivane owns these settings. Pi-native identity, model and protocol variables
// retain their upstream names; they must not be renamed by brand normalization.
const WORKSPACE_VARIABLES = Object.freeze([
    'PROJECT_ROOTS', 'ALLOWED_ORIGINS', 'WEB_TOKEN', 'WEB_SECURE_COOKIE', 'WEB_IDLE_MS',
    'WEB_APPROVE_PROJECTS', 'WEB_CLI', 'WEB_DEFERRED_FILE', 'WORKSPACE_BASE_URL',
    'WORKSPACE_ACCESS_TOKEN', 'MEDIA_PLANNER_MODEL', 'MEDIA_CONFIG_DIR', 'MEDIA_DATA_DIR', 'MEDIA_PROFILE'
]);
function normalizeEnvironment(env) {
    for (const suffix of WORKSPACE_VARIABLES) {
        const current = `PIVANE_${suffix}`, legacy = `PI_${suffix}`;
        if (!env[current]) continue;
        if (env[legacy] && env[legacy] !== env[current]) throw new Error(`Conflicting configuration: ${current} and ${legacy}`);
        env[legacy] = env[current];
    }
    return env;
}
function loadLocalEnv(envPath, env = process.env) {
    normalizeEnvironment(env);
    if (env.PI_MEDIA_PROFILE === 'clean' || !fs.existsSync(envPath)) return;
    const local = {};
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
        if (!match) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        local[match[1]] = value;
    }
    // An inherited value wins over either spelling in the local file.
    for (const suffix of WORKSPACE_VARIABLES) if (env[`PI_${suffix}`] || env[`PIVANE_${suffix}`]) {
        delete local[`PI_${suffix}`]; delete local[`PIVANE_${suffix}`];
    }
    normalizeEnvironment(local);
    for (const [key, value] of Object.entries(local)) if (!env[key]) env[key] = value;
    normalizeEnvironment(env);
}
module.exports = { loadLocalEnv, normalizeEnvironment, WORKSPACE_VARIABLES };
