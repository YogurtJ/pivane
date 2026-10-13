import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { type DisabledFeatureSurface } from "../shared/disabled-features.ts";
export declare const SUBAGENT_SAFETY_GUIDANCE = "SAFETY-CRITICAL SUBAGENT GUIDANCE:\n- Delegate only when the operator asked, directly or through applicable user/project instructions; size, complexity or risk alone is not authorization.\n- Native async completion wakes this session: return control; do not sleep, poll or call bg_wait for it.\n- One writer per cwd/worktree; isolate concurrent writers.\n- After a launch or runtime failure, stop and report it; never silently switch to interactive_shell, pi -ne or another CLI.";
export declare const DEFAULT_SUBAGENT_TOOL_DESCRIPTION: string;
export declare const SUBAGENT_TOOL_PROMPT_SNIPPET = "Delegate focused work to child agents; compose multi-child work in one workflow call.";
export declare const COMPACT_SUBAGENT_TOOL_DESCRIPTION: string;
export declare const FULL_SUBAGENT_TOOL_DESCRIPTION: string;
export interface ToolDescriptionOptions {
    cwd?: string;
    agentDir?: string;
    warn?: (message: string) => void;
    /** Removes lines for disabled features from the default and full descriptions; custom descriptions are unchanged apart from the appended safety guidance. */
    disabledFeatures?: DisabledFeatureSurface;
}
export declare function buildSubagentToolPromptMetadata(config?: Pick<ExtensionConfig, "toolDescriptionMode">, disabledFeatures?: DisabledFeatureSurface): {
    promptSnippet?: string;
};
export declare function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode;
export declare function buildSubagentToolDescription(config?: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): string;
//# sourceMappingURL=tool-description.d.ts.map