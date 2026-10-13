import { type ExternalCliParser } from "./external-cli-runner.ts";
import type { ExternalCliPreflightSpec } from "./external-cli-preflight.ts";
import { type ThinkingLevel } from "../../shared/model-info.ts";
import { type ResolvedModelScope } from "./model-scope.ts";
export declare const CLAUDE_CODE_ADAPTER_ID: "claude-code";
export declare const CLAUDE_CODE_WRITER_ADAPTER_ID: "claude-code-writer";
/** True for the two code-owned adapters that launch the Claude Code CLI. */
export declare function isClaudeCodeAdapterId(value: unknown): value is typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID;
export declare const CLAUDE_CODE_WRITER_TOOLS: "Read,Write,Edit,Glob,Grep";
export declare const CLAUDE_CODE_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USERPROFILE", "USER", "LOGNAME", "TMPDIR", "CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_PROFILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK", "GOOGLE_APPLICATION_CREDENTIALS", "CLOUD_ML_REGION", "ANTHROPIC_VERTEX_PROJECT_ID", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"];
export interface ClaudeCodeOverride {
    /** Tokens appended after the adapter's fixed argv. */
    args: string[];
    /** Model id the launch pins, when it pins one. */
    model?: string;
}
/** The agent-config fields that can pin a model, structurally typed to avoid importing them. */
export interface ClaudeCodeAgentModel {
    model?: string | false;
    modelSource?: {
        type?: string;
        model?: string;
    };
}
/**
 * Resolve an explicit model and thinking level for a code-owned Claude Code
 * adapter. Returns undefined when neither was requested, so the CLI falls back
 * to its own configured default.
 *
 * The level travels as the same `:level` suffix Pi children use:
 * `model: "claude-opus-5.5:high"` pins the model and the effort, and a bare
 * `model: ":high"` takes the effort alone on the agent's own model. A suffix
 * wins over the frontmatter `thinking` value, which is the precedence Pi
 * children already use.
 *
 * Values are validated here because this module owns the adapter's argv: every
 * returned token is passed as its own argv element, and an unusable value is a
 * rejected launch rather than a silently different model. The ceiling is checked
 * against the requested level, not against the effort it maps to.
 */
export declare function resolveClaudeCodeOverride(input: {
    model?: string;
    agent?: ClaudeCodeAgentModel;
    thinking?: string;
    thinkingCeiling?: ThinkingLevel;
    agentName?: string;
    runId?: string;
}): ClaudeCodeOverride | undefined;
/**
 * A Claude Code launch pins a model the Pi registry does not know, so an enforced
 * model scope can only be honored by checking the id the CLI will actually run.
 * A launch that pins nothing cannot be checked at all, and an enforced scope must
 * not be bypassed by staying silent.
 */
export declare function assertClaudeCodeModelScope(input: {
    scopes: readonly ResolvedModelScope[];
    model?: string;
    agent: string;
    runId?: string;
}): void;
export declare function createClaudeCodeJsonlParser(): ExternalCliParser;
export declare function resolveClaudeCodeLaunch(input: {
    adapter: typeof CLAUDE_CODE_ADAPTER_ID | typeof CLAUDE_CODE_WRITER_ADAPTER_ID;
    command: string;
    /** Test-only executable prefix for a fake Claude Code process. */
    commandPrefixArgs?: readonly string[];
    /** Trailing argv for an explicit model/thinking request, built by resolveClaudeCodeOverride. */
    overrideArgs?: readonly string[];
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