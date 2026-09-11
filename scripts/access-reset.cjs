const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { WorkspaceAccessService } = require('../server/workspace-access-service');

if (process.argv.slice(2).join(' ') !== '--disable --confirm') {
    console.error('Usage: PI_CODING_AGENT_DIR=<instance-agent-directory> node scripts/access-reset.cjs --disable --confirm');
    console.error('This local recovery command disables workspace-managed authentication and revokes browser logins. PI_WEB_TOKEN still takes precedence.');
    process.exitCode = 1;
} else {
    const service = new WorkspaceAccessService();
    try {
        let stat;
        try { stat = fs.lstatSync(service.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stat) {
            if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Access configuration must be a regular file; resolve the path on the server first');
            const backup = `${service.filePath}.reset-${Date.now()}-${randomUUID()}`;
            require('../server/pi-private-files').writePrivateFileSync(backup, fs.readFileSync(service.filePath));
        }
        service.write({ version: 1, enabled: false, revision: randomUUID(), sessions: [] });
        console.log('Workspace access reset. Previous configuration was preserved when present.');
        console.log('PI_WEB_TOKEN, if configured in the server environment or .env, still enforces authentication.');
        console.log('Use the same PI_CODING_AGENT_DIR as the server; this command does not load the project .env.');
    } catch { console.error('Access reset failed. Check the instance directory and file permissions; no credentials were printed.'); process.exitCode = 1; }
    finally { service.dispose(); }
}
