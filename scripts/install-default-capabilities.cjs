// This lifecycle hook must never turn optional capability failure into npm ci failure.
const path = require('node:path');
async function main() {
    require('../server/pi-local-env').loadLocalEnv(path.resolve(__dirname, '../.env'));
    const { getAgentDir, SettingsManager, DefaultPackageManager } = await import('@earendil-works/pi-coding-agent');
    const agentDir = getAgentDir(), cwd = path.resolve(__dirname, '..');
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
    if (settingsManager.drainErrors().length) throw new Error('Settings unavailable');
    const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
    manager.setProgressCallback(() => {});
    // Bound npm network retries without printing registry configuration or credentials.
    process.env.npm_config_fetch_retries = '0';
    process.env.npm_config_fetch_timeout = '30000';
    await require('../server/pi-default-capabilities-installer').installDefaults({ agentDir, manager,
        skip: ['1', 'true'].includes(process.env.PI_OFFLINE) || ['1', 'true'].includes(process.env.PI_SKIP_DEFAULT_CAPABILITIES) });
}
main().catch(() => {
    console.warn('[Pivane] Optional capabilities were not installed. Continue using Pivane and check Settings > Models & capabilities.');
    process.exitCode = 0;
});
