const MIB = 1024 * 1024;
// Manifest validity is independent of a later reduction in configured quotas.
const MAX_STORED_FILE_BYTES = 2048 * MIB;
function setting(env, key, fallback, maximum) {
    if (env[key] === undefined || env[key] === '') return fallback * MIB;
    const value = Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum} MiB`);
    return value * MIB;
}
function fileLimits(env = process.env) {
    return {
        downloadBytes: setting(env, 'PIVANE_FILE_DOWNLOAD_MAX_MIB', 512, 2048),
        deliveryFileBytes: setting(env, 'PIVANE_DELIVERY_FILE_MAX_MIB', 512, 2048),
        deliveryTotalBytes: setting(env, 'PIVANE_DELIVERY_TOTAL_MAX_MIB', 1024, 8192)
    };
}
module.exports = { fileLimits, MAX_STORED_FILE_BYTES };
