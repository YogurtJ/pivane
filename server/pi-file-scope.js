const fs = require('node:fs/promises');
const path = require('node:path');
const { getSdk } = require('./pi-session-store');
const { windowsPath, withinCanonical: within } = require('./pi-platform-path');
const policy = require('../public/pi-file-policy');
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });

async function fileScope(store, input) {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096) throw fail('项目目录无效', 400, 'FILE_PATH');
    let cwd;
    try { cwd = store.resolveProject(input); } catch { throw fail('项目目录不可访问', 403, 'FILE_PROJECT'); }
    const { getAgentDir } = await getSdk();
    const privateRoots = await Promise.all([getAgentDir(), process.env.PI_MEDIA_CONFIG_DIR].filter(Boolean).map(async root => {
        try { return await fs.realpath(root); } catch { return path.resolve(root); }
    }));
    const check = (file, lexical = false) => {
        if (process.platform === 'win32') windowsPath(file);
        const inProject = lexical && process.platform === 'win32' ? within(cwd.toLowerCase(), file.toLowerCase()) : within(cwd, file);
        if (!inProject) throw fail('文件不在当前项目内', 403, 'FILE_OUTSIDE');
        if (policy.restricted(file) || privateRoots.some(root => within(root, file))) throw fail('此文件不提供网页预览', 403, 'FILE_PRIVATE');
    };
    check(cwd);
    return { cwd, check };
}
function fileError(error) {
    if (error.status) return error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return fail('文件不存在或已被移走', 404, 'FILE_MISSING');
    if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) return fail('文件不可访问', 403, 'FILE_DENIED');
    return fail('暂时无法读取文件', 500, 'FILE_READ');
}
module.exports = { fileScope, fileError, fail };
