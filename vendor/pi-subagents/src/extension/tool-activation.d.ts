import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolActivationMode } from "../shared/types.ts";
export declare function registerSubagentToolActivation(pi: ExtensionAPI, options: {
    advertisedPrompt: () => string | undefined | Promise<string | undefined>;
    mode?: ToolActivationMode;
}): void;
//# sourceMappingURL=tool-activation.d.ts.map