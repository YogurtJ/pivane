// Read-only installation helper. Use Pi's public resolver rather than duplicating
// platform home-directory or PI_CODING_AGENT_DIR expansion rules.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
    if (process.argv.length !== 2) throw new Error('Usage: node scripts/pi-agent-dir.cjs');
    const { getAgentDir } = await import('@earendil-works/pi-coding-agent');
    let directory = getAgentDir();
    if (!path.isAbsolute(directory) || /[\r\n\0]/.test(directory) || directory.trim() !== directory) {
        throw new Error('PI_CODING_AGENT_DIR must resolve to an absolute, single-line path without surrounding whitespace.');
    }
    try {
        directory = fs.realpathSync.native(directory);
        if (!fs.statSync(directory).isDirectory()) throw new Error('Pi agent path is not a directory.');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        // A first-time Pi user will initialize this location on normal startup.
    }
    if (/[\r\n\0]/.test(directory) || directory.trim() !== directory) {
        throw new Error('Resolved Pi agent path cannot be represented in an instance environment file.');
    }
    process.stdout.write(directory + '\n');
}

main().catch(error => {
    console.error('Cannot resolve Pi agent directory:', error.message);
    process.exitCode = 1;
});
