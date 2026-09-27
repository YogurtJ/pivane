import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FleetKeybindingsConfig, type SubagentState } from "../shared/types.ts";
export declare function registerSlashCommands(pi: ExtensionAPI, state: SubagentState, options?: {
    fleetKeybindings?: FleetKeybindingsConfig;
    foregroundDetachShortcut?: string;
}): {
    dispose: () => void;
};
//# sourceMappingURL=slash-commands.d.ts.map