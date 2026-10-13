import { HERDR_PI_MODE_ENV } from "./src/runs/shared/herdr-pi-protocol.js";
import { loadedPackageVersion, readInstalledPackageVersion } from "./src/shared/package-version.js";
const registerExtension = process.env[HERDR_PI_MODE_ENV] === "1"
    ? (await import("./src/extension/herdr-pi-bridge.js")).default
    : process.env.PI_SUBAGENT_CHILD === "1"
        ? undefined
        : (await import("./src/extension/index.js")).default;
export default function registerSubagentExtension(pi) {
    const installedVersion = readInstalledPackageVersion();
    if (installedVersion !== loadedPackageVersion) {
        throw new Error(`pi-subagents ${installedVersion} is installed, but this Pi process still has ${loadedPackageVersion} loaded. Restart Pi to load the update; /reload cannot replace extension modules that Node has already loaded.`);
    }
    registerExtension?.(pi);
}
//# sourceMappingURL=index.js.map