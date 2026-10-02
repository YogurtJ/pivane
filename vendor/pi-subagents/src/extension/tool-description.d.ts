import type { ExtensionConfig, ToolDescriptionMode } from "../shared/types.ts";
import { type DisabledFeatureSurface } from "../shared/disabled-features.ts";
export declare const SUBAGENT_SAFETY_GUIDANCE: string;
export declare const DEFAULT_SUBAGENT_TOOL_DESCRIPTION: string;
export declare const SUBAGENT_TOOL_PROMPT_SNIPPET = "For operator-requested delegation, use subagents; compose multi-child work in one workflow call.";
export declare const SUBAGENT_TOOL_PROMPT_GUIDELINES: string[];
export declare const COMPACT_SUBAGENT_TOOL_DESCRIPTION: string;
export declare const FULL_SUBAGENT_TOOL_DESCRIPTION: string;
export interface ToolDescriptionOptions {
    cwd?: string;
    agentDir?: string;
    warn?: (message: string) => void;
    /** Removes lines for disabled features from the default and full descriptions; custom descriptions are unchanged apart from the appended safety guidance. */
    disabledFeatures?: DisabledFeatureSurface;
}
export interface SubagentToolPromptMetadata {
    promptSnippet?: string;
    promptGuidelines?: string[];
}
export declare function buildSubagentToolPromptMetadata(config?: Pick<ExtensionConfig, "toolDescriptionMode">, disabledFeatures?: DisabledFeatureSurface): SubagentToolPromptMetadata;
export declare function resolveToolDescriptionMode(config: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): ToolDescriptionMode;
export declare function buildSubagentToolDescription(config?: Pick<ExtensionConfig, "toolDescriptionMode">, options?: ToolDescriptionOptions): string;
//# sourceMappingURL=tool-description.d.ts.map