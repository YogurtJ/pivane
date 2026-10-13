import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
/**
 * The text, without its tags, that the session transcript recorded for one of the prompt sections
 * pi-subagents adds, so that section can keep the wording the session already sent.
 * A session that never recorded the section gets undefined.
 */
export declare function recordedPromptSection(pi: ExtensionAPI, name: string): string | undefined;
/**
 * Register a pi-subagents tool so a session keeps the definition, prompt snippet and guidelines
 * its transcript already declared. Only a session that never declared the tool gets this definition.
 */
export declare function registerPinnedTool<TParams extends TSchema, TDetails>(pi: ExtensionAPI, tool: ToolDefinition<TParams, TDetails>): void;
/**
 * Choose whether this session keeps the pi-subagents definitions and prompt text its transcript
 * declared (the default) or gets the current ones. Call before registering any pinned tool.
 */
export declare function setDeclarationPinning(pi: ExtensionAPI, pinned: boolean): void;
//# sourceMappingURL=declaration-pinning.d.ts.map