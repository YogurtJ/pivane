import type { Message } from "@earendil-works/pi-ai";
export declare const CHILD_TRANSCRIPT_ARTIFACT_VERSION = 1;
type ChildTranscriptSource = "foreground" | "async";
type ChildTranscriptMessage = Message & {
    model?: string;
    errorMessage?: string;
    stopReason?: string;
    usage?: unknown;
};
interface ChildTranscriptEvent {
    type?: string;
    message?: ChildTranscriptMessage;
    toolCallId?: string;
    toolName?: string;
    args?: unknown;
    isError?: boolean;
}
interface ChildTranscriptWriterInput {
    transcriptPath: string;
    source: ChildTranscriptSource;
    runId: string;
    agent: string;
    childIndex?: number;
    cwd: string;
    maxBytes?: number;
}
export interface ChildTranscriptWriter {
    path: string;
    writeInitialUserMessage(prompt: string): void;
    writeChildEvent(event: ChildTranscriptEvent): void;
    writeStdoutLine(line: string): void;
    writeStderrLine(line: string): void;
    writeStderrText(text: string): void;
    getError(): string | undefined;
}
export declare function createChildTranscriptWriter(input: ChildTranscriptWriterInput): ChildTranscriptWriter;
export {};
//# sourceMappingURL=child-transcript.d.ts.map