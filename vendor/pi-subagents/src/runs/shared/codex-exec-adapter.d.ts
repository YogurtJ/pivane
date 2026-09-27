import { type ExternalCliParser } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
export declare const CODEX_EXEC_ADAPTER_ID: "codex-exec";
export declare const CODEX_EXEC_WRITER_ADAPTER_ID: "codex-exec-writer";
export declare const CODEX_EXEC_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USERPROFILE", "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
export declare function createCodexExecJsonlParser(finalMessagePath: string): ExternalCliParser;
export declare function resolveCodexExecLaunch(input: {
    adapter: typeof CODEX_EXEC_ADAPTER_ID | typeof CODEX_EXEC_WRITER_ADAPTER_ID;
    command: string;
    asyncDir: string;
    stepIndex: number;
    /** Test-only executable prefix for a fake Codex process. */
    commandPrefixArgs?: readonly string[];
}): {
    command: string;
    args: string[];
    finalOutputPath: string;
    promptFilePath?: undefined;
    temporaryDirectories?: undefined;
    environment: {
        allowlist: readonly string[];
    };
    preflight: ExternalCliPreflightSpec;
    parser: ExternalCliParser;
};
//# sourceMappingURL=codex-exec-adapter.d.ts.map