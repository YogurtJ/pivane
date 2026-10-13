const path = require('node:path');
const os = require('node:os');

const sessionPathFields = new Set(['sessionFile', 'nativeSessionFile', 'parentSessionFile', 'sessionDir', 'defaultSessionDir']);
// This class classifies structured metadata only. It never opens a path from a
// conversation or a run artifact; external/custom roots make the audit incomplete.
class NativeDocumentScope {
    constructor(agent) {
        this.root = path.join(agent, 'sessions'); this.complete = true; this.projects = new Set();
        if (process.env.PI_CODING_AGENT_SESSION_DIR) this.reference(process.env.PI_CODING_AGENT_SESSION_DIR);
    }
    reference(value, overflow = false) {
        if (value === '' || value === null || value === false) return;
        if (overflow || typeof value !== 'string') { this.complete = false; return; }
        const expanded = value.startsWith('~/') || value.startsWith('~\\') ? path.join(os.homedir(), value.slice(2)) : value;
        if (!path.isAbsolute(expanded)) { this.complete = false; return; }
        const resolved = path.resolve(expanded);
        if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) this.complete = false;
    }
    project(header) {
        if (header?.type !== 'session') return;
        if (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || header.cwd.length > 4096 || !this.projects.has(header.cwd) && this.projects.size >= 1000) {
            this.complete = false; return;
        }
        this.projects.add(header.cwd);
    }
    snapshot() { return { root: this.root, complete: this.complete, projects: [...this.projects].sort() }; }
}
module.exports = { NativeDocumentScope, sessionPathFields };
