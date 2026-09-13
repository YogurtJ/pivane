const path = require('node:path');
const { inspectBackup, restoreBackup } = require('../server/pi-maintenance-restore');
(async () => {
    const [id, confirmation, ...extra] = process.argv.slice(2);
    if (!id || extra.length || confirmation && confirmation !== '--apply-when-stopped') throw new Error('Usage: node scripts/restore-managed-backup.cjs <backup-id> [--apply-when-stopped]');
    const root = path.resolve(__dirname, '..');
    if (confirmation) console.log(JSON.stringify(await restoreBackup(root, id), null, 2));
    else {
        const plan = inspectBackup(root, id);
        console.log(JSON.stringify({ verified: true, backup: id, files: plan.files, bytes: plan.bytes, roots: plan.manifest.roots,
            piVersion: plan.installation.package.dependencies['@earendil-works/pi-coding-agent'], applied: false }, null, 2));
    }
})().catch(() => { console.error('Backup verification or restoration failed. No success is claimed. Check the backup ID, permissions, retained installation and that all writers are stopped; any safety snapshot is retained.'); process.exitCode = 1; });
