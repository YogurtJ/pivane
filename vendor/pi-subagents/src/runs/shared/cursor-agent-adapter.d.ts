import { type ExternalCliParser } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
export declare const CURSOR_AGENT_ADAPTER_ID: "cursor-agent";
export declare const CURSOR_AGENT_WRITER_ADAPTER_ID: "cursor-agent-writer";
export declare const CURSOR_AGENT_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USERPROFILE", "CURSOR_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
export declare function createCursorAgentJsonlParser(): ExternalCliParser;
export declare function resolveCursorAgentLaunch(input: {
    adapter: typeof CURSOR_AGENT_ADAPTER_ID | typeof CURSOR_AGENT_WRITER_ADAPTER_ID;
    command: string;
    cwd: string;
    asyncDir: string;
    stepIndex: number;
    /** Test-only executable prefix for a fake Cursor Agent process. */
    commandPrefixArgs?: readonly string[];
}): {
    command: string;
    args: string[];
    finalOutputPath?: undefined;
    promptFilePath: string;
    temporaryDirectories: string[];
    environment: {
        allowlist: readonly string[];
    };
    preflight: ExternalCliPreflightSpec;
    parser: ExternalCliParser;
};
//# sourceMappingURL=cursor-agent-adapter.d.ts.map