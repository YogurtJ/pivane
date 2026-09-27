import { type ExternalCliParser } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
export declare const CLAUDE_CODE_ADAPTER_ID: "claude-code";
export declare const CLAUDE_CODE_WRITER_ADAPTER_ID: "claude-code-writer";
export declare const CLAUDE_CODE_WRITER_TOOLS: "Read,Write,Edit,Glob,Grep";
export declare const CLAUDE_CODE_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "TMPDIR", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
export declare function createClaudeCodeJsonlParser(): ExternalCliParser;
export declare function resolveClaudeCodeLaunch(input: {
    adapter: typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID;
    command: string;
    /** Test-only executable prefix for a fake Claude Code process. */
    commandPrefixArgs?: readonly string[];
}): {
    command: string;
    args: string[];
    finalOutputPath?: undefined;
    promptFilePath?: undefined;
    temporaryDirectories?: undefined;
    environment: {
        allowlist: readonly string[];
    };
    preflight: ExternalCliPreflightSpec;
    parser: ExternalCliParser;
};
//# sourceMappingURL=claude-code-adapter.d.ts.map