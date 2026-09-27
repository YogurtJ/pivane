import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type PiSpawnDeps } from "../runs/shared/pi-spawn.ts";
/** Returns why dynamic tool activation is unavailable, or undefined when the host supports it. */
export declare function unsupportedDynamicToolsReason(pi: ExtensionAPI, deps?: PiSpawnDeps): string | undefined;
export declare function supportsMinimumVersion(version: string): boolean;
export declare function registerSubagentToolActivation(pi: ExtensionAPI, options: {
    advertisedPrompt: () => string | undefined;
}): void;
//# sourceMappingURL=tool-activation.d.ts.map