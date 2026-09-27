import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, getProjectConfigDir } from "./utils.js";
export function getPromptDirectories(cwd) {
    return {
        package: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "prompts"),
        user: path.join(getAgentDir(), "prompts"),
        project: path.join(getProjectConfigDir(cwd), "prompts"),
    };
}
//# sourceMappingURL=prompt-resources.js.map