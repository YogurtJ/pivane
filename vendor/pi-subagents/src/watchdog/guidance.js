import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, getProjectConfigDir } from "../shared/utils.js";
export const WATCHDOG_GUIDANCE_MAX_CHARS = 8_000;
function readOptional(filePath) {
    try {
        return fs.readFileSync(filePath, "utf-8").trim();
    }
    catch {
        return "";
    }
}
/** Read fresh on every review; project file first, then user file. */
export function loadWatchdogGuidance(cwd, enabled) {
    if (!enabled)
        return "";
    const sections = [getProjectConfigDir(cwd), getAgentDir()].map((dir) => readOptional(path.join(dir, "WATCHDOG.md"))).filter(Boolean);
    return sections.join("\n\n").slice(0, WATCHDOG_GUIDANCE_MAX_CHARS);
}
//# sourceMappingURL=guidance.js.map