import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type FleetKeybindingsConfig, type SubagentState } from "../shared/types.ts";
export declare function registerSlashCommands(pi: ExtensionAPI, state: SubagentState, options?: {
    fleetKeybindings?: FleetKeybindingsConfig;
    foregroundDetachShortcut?: string;
    /** disabledFeatures "workflow-scripts": /run launches its one child directly instead of through a script. */
    workflowScriptsDisabled?: boolean;
}): {
    dispose: () => void;
};
//# sourceMappingURL=slash-commands.d.ts.map