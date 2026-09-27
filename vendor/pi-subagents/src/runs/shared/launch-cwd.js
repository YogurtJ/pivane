import * as fs from "node:fs";
export function preflightLaunchCwd(requestedCwd, effectiveCwd) {
    const resolution = requestedCwd === effectiveCwd ? "" : `\n(resolved from ${JSON.stringify(requestedCwd)})`;
    try {
        if (!fs.statSync(effectiveCwd).isDirectory()) {
            return `Subagent launch aborted: cwd is not a directory: ${effectiveCwd}${resolution}`;
        }
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return `Subagent launch aborted: cwd does not exist: ${effectiveCwd}${resolution}`;
        }
        return `Subagent launch aborted: cwd could not be accessed: ${effectiveCwd}${resolution}\n${error instanceof Error ? error.message : String(error)}`;
    }
    return undefined;
}
//# sourceMappingURL=launch-cwd.js.map