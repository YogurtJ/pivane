/**
 * Agent discovery and configuration
 */
import * as fs from "node:fs";
import type { AcceptanceInput, AcceptanceRole, AgentRunnerConfig, JsonSchemaObject, OutputMode, ToolBudgetConfig } from "../shared/types.ts";
import { type ModelScopeConfig } from "../runs/shared/model-scope.ts";
export { BUILTIN_AGENT_NAMES } from "./builtin-names.ts";
export { buildRuntimeName, frontmatterNameForConfig, parsePackageName } from "./identity.ts";
import { type PermissionRules } from "../runs/shared/permissions.ts";
import { type ThinkingLevel } from "../shared/thinking-ceiling.ts";
export type AgentScope = "user" | "project" | "both";
export type AgentSource = "builtin" | "package" | "user" | "project" | "runtime";
type SystemPromptMode = "append" | "replace";
export type AgentDefaultContext = "fresh" | "fork";
export type AgentMemoryScope = "project" | "user";
export interface AgentMemoryConfig {
    scope: AgentMemoryScope;
    path: string;
}
export declare function defaultSystemPromptMode(name: string): SystemPromptMode;
export declare function defaultInheritProjectContext(name: string): boolean;
export declare function defaultInheritSkills(): boolean;
export interface BuiltinAgentOverrideBase {
    description?: string;
    machine?: string;
    output?: string;
    outputMode?: OutputMode;
    defaultReads?: string[];
    model?: string;
    modelProvider?: string;
    fast?: boolean;
    thinking?: string | false;
    systemPromptMode: SystemPromptMode;
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    defaultContext?: AgentDefaultContext;
    acceptanceRole?: AcceptanceRole;
    disabled?: boolean;
    systemPrompt: string;
    skills?: string[];
    skillPath?: string[];
    tools?: string[];
    excludeTools?: string[];
    allowNestedSubagents?: boolean;
    allowedAgents?: string[];
    mcpDirectTools?: string[];
    extensions?: string[];
    subagentOnlyExtensions?: string[];
    mutationTools?: string[];
    toolBudget?: ToolBudgetConfig;
}
interface BuiltinAgentOverrideConfig {
    description?: string;
    machine?: string | false;
    output?: string | false;
    outputMode?: OutputMode;
    defaultReads?: string[] | false;
    model?: string | false;
    defaultProvider?: string | false;
    fast?: boolean;
    thinking?: string | false;
    systemPromptMode?: SystemPromptMode;
    inheritProjectContext?: boolean;
    inheritGlobalContext?: boolean;
    inheritSkills?: boolean;
    defaultContext?: AgentDefaultContext | false;
    acceptanceRole?: AcceptanceRole | false;
    disabled?: boolean;
    systemPrompt?: string;
    skills?: string[] | false;
    tools?: string[] | false | "inherit";
    excludeTools?: string[] | false;
    allowNestedSubagents?: boolean;
    allowedAgents?: string[] | false;
    extensions?: string[] | false;
    subagentOnlyExtensions?: string[] | false;
    mutationTools?: string[] | false;
    toolBudget?: ToolBudgetConfig | false;
}
interface BuiltinAgentOverrideInfo {
    scope: "user" | "project";
    path: string;
    base: BuiltinAgentOverrideBase;
    fields?: string[];
    fieldScopes?: Record<string, Array<"user" | "project">>;
}
export interface AgentModelSourceInfo {
    type: "subagents.defaultModel";
    scope: "user" | "project";
    path: string;
    model: string;
    defaultProvider?: string;
}
export interface AgentConfig {
    name: string;
    runner?: AgentRunnerConfig;
    localName?: string;
    packageName?: string;
    packageSourceName?: string;
    packageSourceVersion?: string;
    packageSourceRoot?: string;
    description: string;
    advertise?: boolean;
    aliases?: string[];
    tools?: string[];
    excludeTools?: string[];
    allowNestedSubagents?: boolean;
    allowedAgents?: string[];
    mcpDirectTools?: string[];
    model?: string;
    modelProvider?: string;
    fast?: boolean;
    thinking?: string | false;
    systemPromptMode: SystemPromptMode;
    inheritProjectContext: boolean;
    inheritGlobalContext: boolean;
    inheritSkills: boolean;
    defaultContext?: AgentDefaultContext;
    defaultAsync?: boolean;
    defaultTimeoutMs?: number;
    defaultToolTimeoutMs?: number;
    defaultAcceptance?: AcceptanceInput;
    acceptanceRole?: AcceptanceRole;
    systemPrompt: string;
    source: AgentSource;
    filePath: string;
    discoveryPriority?: number;
    skills?: string[];
    skillPath?: string[];
    extensions?: string[];
    extensionsFromDefault?: boolean;
    subagentOnlyExtensions?: string[];
    mutationTools?: string[];
    output?: string;
    outputMode?: OutputMode;
    outputSchema?: JsonSchemaObject;
    defaultReads?: string[];
    defaultProgress?: boolean;
    interactive?: boolean;
    maxSubagentDepth?: number;
    toolBudget?: ToolBudgetConfig;
    permissions?: PermissionRules;
    memory?: AgentMemoryConfig;
    machine?: string;
    disabled?: boolean;
    extraFields?: Record<string, string>;
    override?: BuiltinAgentOverrideInfo;
    modelSource?: AgentModelSourceInfo;
    maxThinking?: ThinkingLevel;
    /**
     * Digest of the parsed definition, set when a runtime overlay such as the
     * Intercom bridge rewrites launch-affecting fields. Launch identity reads
     * this instead of re-hashing the overlaid copy.
     */
    definitionDigest?: string;
}
export interface ChainStepConfig {
    agent?: string;
    task?: string;
    phase?: string;
    label?: string;
    as?: string;
    outputSchema?: string | Record<string, unknown>;
    machine?: string;
    output?: string | false;
    outputMode?: OutputMode;
    reads?: string[] | false;
    model?: string;
    skills?: string[] | false;
    progress?: boolean;
    parallel?: unknown;
    expand?: unknown;
    collect?: unknown;
    concurrency?: number;
    failFast?: boolean;
    worktree?: boolean;
    acceptance?: AcceptanceInput;
    toolBudget?: ToolBudgetConfig;
}
export interface ChainConfig {
    name: string;
    localName?: string;
    packageName?: string;
    description: string;
    source: AgentSource;
    filePath: string;
    steps: ChainStepConfig[];
    extraFields?: Record<string, string>;
}
export interface ChainDiscoveryDiagnostic {
    source: AgentSource;
    filePath: string;
    error: string;
}
export interface AgentDiscoveryDiagnostic extends ChainDiscoveryDiagnostic {
    name?: string;
    runtimeName?: string;
    packageSpecified?: boolean;
    discoveryPriority?: number;
}
export declare function findBlockingAgentDiagnostic(name: string, agent: AgentConfig | readonly AgentConfig[] | undefined, diagnostics: AgentDiscoveryDiagnostic[] | undefined): AgentDiscoveryDiagnostic | undefined;
export type AgentDefinitionDirectoryState = "absent" | "empty" | "candidates" | "unreadable" | "not-directory";
/** A definition directory actually inspected during one agent-discovery operation. */
export interface AgentDefinitionDirectoryReport {
    source: AgentSource;
    path: string;
    state: AgentDefinitionDirectoryState;
    candidateCount?: number;
}
/**
 * Filesystem provenance for a failed agent resolution. Context is created from
 * the discovery result that supplied the effective agents; callers must not
 * pair arbitrary agent arrays with these directory reports.
 */
export interface UnknownAgentDiagnosticContext {
    cwd: string;
    scope: AgentScope;
    directories: readonly AgentDefinitionDirectoryReport[];
    agents: readonly AgentConfig[];
}
export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
    projectAgentsDir: string | null;
    cwd: string;
    scope: AgentScope;
    directories: readonly AgentDefinitionDirectoryReport[];
    modelScope?: ModelScopeConfig;
    maxThinking?: ThinkingLevel;
}
/** Create formatter input from the exact discovery operation used for resolution. */
export declare function unknownAgentDiagnosticContext(discovered: Pick<AgentDiscoveryResult, "cwd" | "scope" | "directories" | "agents">): UnknownAgentDiagnosticContext;
/** Render local discovery evidence without exposing filesystem error details. */
export declare function formatUnknownAgentError(name: string, context: UnknownAgentDiagnosticContext, prefix?: string): string;
export declare function resolveAgentName(name: string, agents: AgentConfig[]): {
    agent?: AgentConfig;
    error?: string;
};
export declare function findNearestGitRoot(cwd: string): string | null;
export declare function findNearestProjectRoot(cwd: string): string | null;
export declare function findConfiguredProjectRoot(cwd: string): string | null;
export interface RuntimeAgentSettingsContext {
    cwd: string;
    scope: AgentScope;
    preferredModelProvider?: string;
}
/**
 * Runtime-registered agents keep their extension-owned definition (prompt,
 * tools, context, budgets, and every other launch field) but follow the same
 * model-tier settings as every other agent: `subagents.defaultModel`,
 * `defaultProvider`, `defaultThinking`, and the `model`, `defaultProvider`,
 * `fast`, and `thinking` fields of `agentOverrides.<name>`, user then project,
 * provider-scoped overrides included. Other override fields are ignored for
 * runtime agents. A definition `model` still wins over `defaultModel`.
 */
export declare function applyRuntimeAgentSettings(agents: AgentConfig[], context: RuntimeAgentSettingsContext): AgentConfig[];
export declare function buildBuiltinOverrideConfig(base: BuiltinAgentOverrideBase, draft: Pick<AgentConfig, "model" | "modelProvider" | "fast" | "thinking" | "systemPromptMode" | "inheritProjectContext" | "inheritGlobalContext" | "inheritSkills" | "defaultContext" | "acceptanceRole" | "disabled" | "systemPrompt" | "skills" | "tools" | "allowNestedSubagents" | "mcpDirectTools" | "extensions" | "subagentOnlyExtensions" | "mutationTools" | "toolBudget"> & Partial<Pick<AgentConfig, "description" | "machine" | "output" | "outputMode" | "defaultReads" | "excludeTools">>): BuiltinAgentOverrideConfig | undefined;
export declare function saveBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project", override: BuiltinAgentOverrideConfig): string;
export declare function removeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project", options?: {
    preserveMachine?: boolean;
}): {
    path: string;
    removed: boolean;
    machinePreserved: boolean;
};
export declare function mergeBuiltinAgentOverride(cwd: string, name: string, scope: "user" | "project", fields: BuiltinAgentOverrideConfig): string;
export declare function removeBuiltinAgentOverrideFields(cwd: string, name: string, scope: "user" | "project", fields: string[]): {
    path: string;
    removed: boolean;
};
export interface AgentDefinitionInspection {
    files: string[];
    state: AgentDefinitionDirectoryState;
}
/** Narrow filesystem seam so unavailable paths can be tested without permissions. */
export interface AgentDefinitionInspectionFs {
    existsSync(filePath: string): boolean;
    realpathSync?(filePath: string): string;
    statSync(filePath: string): {
        isDirectory(): boolean;
    };
    readdirSync(dir: string): fs.Dirent[];
}
/**
 * Inspect one agent-definition directory while retaining traversal failure
 * state. A nested unreadable directory makes the whole inspection unavailable,
 * preventing a partial traversal from being reported as empty or complete.
 */
export declare function inspectAgentDefinitionDirectory(dir: string, operations?: AgentDefinitionInspectionFs, isExcluded?: (filePath: string) => boolean): AgentDefinitionInspection;
export declare const EXTRA_AGENT_DIRS_ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";
export interface AgentDiscoveryAllResult {
    builtin: AgentConfig[];
    package: AgentConfig[];
    user: AgentConfig[];
    project: AgentConfig[];
    cwd: string;
    agentDiagnostics?: AgentDiscoveryDiagnostic[];
    chains: ChainConfig[];
    chainDiagnostics: ChainDiscoveryDiagnostic[];
    userDir: string;
    projectDir: string | null;
    userChainDir: string;
    projectChainDir: string | null;
    userSettingsPath: string;
    projectSettingsPath: string | null;
    maxThinking?: ThinkingLevel;
}
/**
 * A single fresh source scan with both projections retained. The effective
 * projection intentionally remains separate from the all-source projection:
 * disabled and shadowed definitions are needed for diagnostics and runtime
 * collision checks even when they are not launchable.
 */
export interface AgentDiscoverySnapshot {
    effective: AgentDiscoveryResult;
    all: AgentDiscoveryAllResult;
}
/** Clear process-local discovery snapshots, primarily for hosts that reload settings in place. */
export declare function clearAgentDiscoveryCache(): void;
export declare function discoverAgentSnapshot(cwd: string, scope: AgentScope, preferredModelProvider?: string, options?: {
    includeChains?: boolean;
}): AgentDiscoverySnapshot;
export declare function discoverAgents(cwd: string, scope: AgentScope, preferredModelProvider?: string): AgentDiscoveryResult;
export declare function discoverAgentsAll(cwd: string, preferredModelProvider?: string): AgentDiscoveryAllResult;
//# sourceMappingURL=agents.d.ts.map