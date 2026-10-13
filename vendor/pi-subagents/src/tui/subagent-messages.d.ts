import { type Theme } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
interface SubagentMessage {
    customType: string;
    content: unknown;
    details?: unknown;
}
interface SubagentEntry {
    customType: string;
    data?: unknown;
}
/** Every message type pi-subagents shows in the main chat. */
export declare const SUBAGENT_MESSAGE_TYPES: readonly string[];
/** Every session entry type pi-subagents shows in the main chat. */
export declare const SUBAGENT_ENTRY_TYPES: readonly string[];
export declare function renderSubagentMessage(message: SubagentMessage, options: {
    expanded: boolean;
}, theme: Theme): Component | undefined;
export declare function renderSubagentEntry(entry: SubagentEntry, options: {
    expanded: boolean;
}, theme: Theme): Component | undefined;
export {};
//# sourceMappingURL=subagent-messages.d.ts.map