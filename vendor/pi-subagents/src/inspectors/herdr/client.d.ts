import { spawn } from "node:child_process";
export type HerdrErrorCode = "HERDR_UNAVAILABLE" | "HERDR_UNSUPPORTED_VERSION" | "PANE_GONE" | "NOT_FOUND" | "TIMEOUT" | "VALIDATION_ERROR";
export type HerdrResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: {
        code: HerdrErrorCode;
        message: string;
        details?: unknown;
    };
};
export interface HerdrClient {
    run<T = unknown>(args: string[], options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
        textOk?: boolean;
    }): Promise<HerdrResult<T>>;
}
type SpawnHerdr = (command: string, args: readonly string[], options: {
    shell: false;
    windowsHide: true;
    env: NodeJS.ProcessEnv;
}) => ReturnType<typeof spawn>;
export declare function createHerdrClient(options?: {
    bin?: string;
    spawn?: SpawnHerdr;
}): HerdrClient;
export interface HerdrVersion {
    major: number;
    minor: number;
    patch: number;
}
export declare function parseHerdrVersion(value: string): HerdrVersion | undefined;
export declare function supportsRawPanes(version: HerdrVersion): boolean;
export declare function detectHerdr(client: HerdrClient, signal?: AbortSignal): Promise<HerdrResult<{
    version: HerdrVersion;
    versionText: string;
}>>;
export {};
//# sourceMappingURL=client.d.ts.map