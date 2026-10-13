import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export declare const CHILD_COMMAND_TOOL = "subagent_command";
export type CommandOperation = "status" | "yield" | "cancel";
export interface ChildCommandSnapshot {
    toolCallId: string;
    state: "running" | "yielded" | "cancel_requested" | "completed" | "failed" | "cancelled";
    startedAt: number;
    endedAt?: number;
    output: string;
    fullOutputPath?: string;
}
export interface ChildCommandState {
    ownerId: string;
    closed: boolean;
    commands: ChildCommandSnapshot[];
}
export declare function readChildCommandState(channelDir: string): ChildCommandState | undefined;
/** Owns command lifetimes, not shell execution. The supplied Pi tool still executes the command. */
export declare function createChildCommandRuntime(channelDir: string): {
    state: () => ChildCommandState;
    operate: (operation: CommandOperation, toolCallId?: string) => ChildCommandState;
    shutdown: () => Promise<void>;
    finish(): Promise<void>;
    wrap(tool: ToolDefinition): ToolDefinition;
    tool(): ToolDefinition;
};
export declare function controlChildCommand(channelDir: string, operation: CommandOperation, toolCallId?: string, signal?: AbortSignal): Promise<ChildCommandState>;
//# sourceMappingURL=child-commands.d.ts.map