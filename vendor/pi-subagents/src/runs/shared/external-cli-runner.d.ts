import type { ExternalProcessStatus } from "../../shared/types.ts";
import { type ExternalCliPreflightResult, type ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
export declare function buildExternalCliPrompt(systemInstructions: string, task: string): string;
export interface ExternalCliParserProgress {
    phase: string;
    eventCount: number;
    message?: string;
}
export interface ExternalCliParserTerminal {
    state: "completed" | "failed";
    output?: string;
    error?: string;
}
export interface ExternalCliParser {
    parseLine(line: string): ExternalCliParserProgress | undefined;
    /** Inspect only a bounded prefix when a non-terminal event exceeds the normal line cap. */
    skipOversizedLine?(prefix: string, byteLength: number): ExternalCliParserProgress | undefined;
    finish(): ExternalCliParserTerminal | undefined;
}
export declare function parseExternalCliJsonlEvent(line: string, label: string, maxTypeLength: number): Record<string, unknown>;
export interface ExternalCliRunResult {
    output: string;
    exitCode: number | null;
    error?: string;
    timedOut?: boolean;
    stopped?: boolean;
    processSignal?: string | null;
    externalProcess: ExternalProcessStatus;
    parserTerminal?: ExternalCliParserTerminal;
    preflight?: ExternalCliPreflightResult;
}
interface StreamLimits {
    stdoutLogBytes?: number;
    stderrLogBytes?: number;
    parserLineBytes?: number;
    parserStreamBytes?: number;
    parserOutputBytes?: number;
}
export declare function runExternalCli(input: {
    command: string;
    args?: string[];
    cwd: string;
    prompt: string;
    asyncDir: string;
    stepIndex: number;
    environment?: {
        allowlist: readonly string[];
        values?: Readonly<Record<string, string>>;
    };
    preflight?: ExternalCliPreflightSpec;
    parser?: ExternalCliParser;
    finalOutputPath?: string;
    promptFilePath?: string;
    temporaryDirectories?: readonly string[];
    limits?: StreamLimits;
    registerTimeout?: (stop: (() => void) | undefined) => void;
    registerStop?: (stop: (() => void) | undefined) => void;
    timeoutMessage?: string;
    stopMessage?: string;
    onProcess?: (process: ExternalProcessStatus) => void;
    onParserProgress?: (progress: ExternalCliParserProgress) => void;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
}): Promise<ExternalCliRunResult>;
export {};
//# sourceMappingURL=external-cli-runner.d.ts.map