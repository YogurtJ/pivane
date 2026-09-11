const path = require('node:path');
// A configured bridge is trusted executable code. On Windows, explicitly named
// Node scripts use this runtime; command text remains one argv value and all
// user text/media payloads stay on stdin. Never enable cmd.exe shell parsing.
function bridgeProcess(executable, args) {
    if (process.platform === 'win32' && ['.js', '.cjs', '.mjs'].includes(path.extname(executable).toLowerCase())) {
        return { executable: process.execPath, args: [executable, ...args] };
    }
    return { executable, args };
}
module.exports = { bridgeProcess };
