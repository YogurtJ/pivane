/** Pi's default undici header/body idle timeout. */
export declare const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300000;
export interface HttpIdleTimeoutResolution {
    timeoutMs: number;
    source: "project" | "global" | "default";
    warning?: string;
}
/**
 * Mirrors pi-coding-agent's `parseHttpIdleTimeoutMs`: numbers (or numeric
 * strings) are floored, `"disabled"` means 0, anything else is invalid.
 */
export declare function parseHttpIdleTimeoutMs(value: unknown): number | undefined;
/**
 * Resolves Pi's `httpIdleTimeoutMs` the way the host does: the project
 * `.pi/settings.json` overrides the global `<agentDir>/settings.json`, and an
 * unset value falls back to 300 000 ms. Detached runners install their own
 * undici dispatcher before pi-coding-agent is loaded, so they cannot borrow
 * Pi's SettingsManager and must read the setting themselves.
 */
export declare function resolveHttpIdleTimeoutMs(options: {
    agentDir: string;
    cwd: string;
}): HttpIdleTimeoutResolution;
/** Dispatcher options shared by the runner and its regression test. */
export declare function runnerHttpDispatcherOptions(timeoutMs: number): {
    allowH2: false;
    proxyTunnel: true;
    headersTimeout: number;
    bodyTimeout: number;
};
/**
 * Installs the runner's proxy-aware undici dispatcher as the process global and
 * routes global fetch through it, with header/body idle clocks taken from Pi's
 * `httpIdleTimeoutMs`. Detached runners skip Pi's CLI dispatcher setup: the Node
 * entrypoint never runs it, and the binary bootstrap runs inside the extension
 * factory, before Pi applies the setting to its own dispatcher. Best effort: a
 * failure logs and leaves the existing dispatcher in place.
 */
export declare function installRunnerHttpDispatcher(options: {
    agentDir: string;
    cwd: string;
}): void;
//# sourceMappingURL=runner-http-dispatcher.d.ts.map