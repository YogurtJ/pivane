export declare const HERDR_PI_PROTOCOL = 1;
export declare const HERDR_PI_MAX_FRAME_BYTES: number;
export declare const HERDR_PI_MODE_ENV = "PI_SUBAGENTS_HERDR_BRIDGE";
export declare const HERDR_PI_RUN_ENV = "PI_SUBAGENTS_HERDR_RUN_ID";
export declare const HERDR_PI_RUNTIME_DIR_ENV = "PI_SUBAGENTS_HERDR_RUNTIME_DIR";
export declare function validateHerdrPiRunId(value: unknown): string;
export declare function herdrPiRuntimeRoot(agentDir: string): string;
export declare function herdrPiRunDir(agentDir: string, runId: string): string;
export interface HerdrPiFrame {
    protocol: number;
    runId: string;
    type: string;
    requestId?: string;
    [key: string]: unknown;
}
export declare function encodeHerdrPiFrame(frame: HerdrPiFrame): Buffer;
export declare class HerdrPiFrameDecoder {
    #private;
    push(chunk: Buffer): HerdrPiFrame[];
    end(): void;
}
//# sourceMappingURL=herdr-pi-protocol.d.ts.map