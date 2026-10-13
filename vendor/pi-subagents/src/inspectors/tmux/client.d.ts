export type TmuxErrorCode = "TMUX_UNAVAILABLE" | "TMUX_ERROR" | "PANE_GONE" | "TIMEOUT";
export type TmuxResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: {
        code: TmuxErrorCode;
        message: string;
        details?: unknown;
    };
};
export interface TmuxClient {
    run(args: string[], options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<TmuxResult<string>>;
}
type ExecTmux = (file: string, args: readonly string[], options: {
    timeout: number;
    signal?: AbortSignal;
}, callback: (error: Error | null, stdout: string, stderr?: string) => void) => unknown;
export declare function createTmuxClient(options?: {
    bin?: string;
    exec?: ExecTmux;
}): TmuxClient;
export {};
//# sourceMappingURL=client.d.ts.map