import * as fs from "node:fs";
import * as path from "node:path";
function pathWithin(base, candidate) {
    const resolvedBase = path.resolve(base);
    const resolvedCandidate = path.resolve(candidate);
    return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}
export function isTrustedRecordedSessionFile(realPath, recordedFiles, sessionsBase) {
    if (!sessionsBase || recordedFiles.length === 0)
        return false;
    try {
        const realSessionsBase = fs.realpathSync(sessionsBase);
        if (!pathWithin(realSessionsBase, realPath))
            return false;
        return recordedFiles.some((file) => fs.realpathSync(path.resolve(file)) === realPath);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=session-file-trust.js.map