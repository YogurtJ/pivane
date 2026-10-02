import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
export type ReplyWorkflowScript = {
    script: string;
} | {
    error: string;
};
/**
 * Pi persists the whole assistant message before running its tool calls, so the
 * message that issued this subagent call is on the branch and carries the script.
 */
export declare function readReplyWorkflowScript(sessionManager: Pick<ExtensionContext["sessionManager"], "getBranch">, toolCallId: string): ReplyWorkflowScript;
//# sourceMappingURL=reply-workflow-script.d.ts.map