import { HERDR_PI_MODE_ENV } from "./src/runs/shared/herdr-pi-protocol.js";
const registerExtension = process.env[HERDR_PI_MODE_ENV] === "1"
    ? (await import("./src/extension/herdr-pi-bridge.js")).default
    : process.env.PI_SUBAGENT_CHILD === "1"
        ? undefined
        : (await import("./src/extension/index.js")).default;
export default function registerSubagentExtension(pi) {
    registerExtension?.(pi);
}
//# sourceMappingURL=index.js.map