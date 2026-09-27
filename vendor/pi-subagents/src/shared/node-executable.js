import * as fs from "node:fs";
import * as path from "node:path";
function isNodeExecutableName(execPath) {
    const basename = path.basename(execPath).toLowerCase();
    return basename === "node" || basename === "node.exe" || basename === "nodejs" || basename === "nodejs.exe";
}
function canUseNodeExecutable(execPath) {
    try {
        fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function resolveNodeExecutable(execPath = process.execPath) {
    if (isNodeExecutableName(execPath) && canUseNodeExecutable(execPath))
        return execPath;
    return process.platform === "win32" ? "node.exe" : "node";
}
//# sourceMappingURL=node-executable.js.map