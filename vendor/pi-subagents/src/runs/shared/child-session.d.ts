import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChildRuntimeConfig } from "./child-runtime-config.ts";
import type { RequiredChildExtensionSnapshot } from "../../shared/required-child-extensions.ts";
import type { HerdrMachineReference, HerdrRemoteGitStatus } from "../../shared/types.ts";
export interface ChildSessionEvent {
    type: string;
    [key: string]: unknown;
}
/** Mirror pi's JSON event projection: `message_update` drops the partial message. */
export declare function projectChildSessionEventForJson(event: ChildSessionEvent): unknown;
export interface ChildSessionExtensionError {
    extensionPath: string;
    event: string;
    error: unknown;
}
export interface ChildHookExtension {
    name: string;
    factory: (pi: ExtensionAPI) => void;
}
export type ChildSessionStorage = {
    kind: "file";
    sessionFile: string;
} | {
    kind: "dir";
    sessionDir: string;
} | {
    kind: "default";
} | {
    kind: "memory";
};
export interface ChildSessionLaunch {
    cwd: string;
    /** Resolved pane-native placement. Local launches omit this field. */
    machine?: HerdrMachineReference;
    /** The launching session's project trust; undefined keeps Pi's default for hosts without trust. */
    projectTrusted?: boolean;
    /** Process-local provider source owned by the invoking foreground parent. */
    parentProviderRegistry?: ParentProviderRegistry;
    /** Logical names resolved only by the remote ambient package. */
    remoteResources?: {
        agent: string;
        skills?: string[];
        toolCeiling?: string[];
        reads?: string[] | false;
    };
    storage: ChildSessionStorage;
    /** Model reference as the agent config names it (`provider/id`, optionally `:thinking`). */
    model?: string;
    /** Explicit tool allowlist; undefined keeps pi's defaults. */
    tools?: string[];
    /** Tools of Pi's built-in MCP extension the child must declare to its model directly, with the `mcp:` selector that granted each; `tools` names them too. */
    builtinMcpTools?: Array<{
        name: string;
        selector: string;
    }>;
    excludeTools?: string[];
    /** Extension files loaded for this child in addition to the inline hooks. */
    extensionPaths: string[];
    /** Canonical required paths and safe evidence identities for fail-closed loading. */
    requiredExtensions?: RequiredChildExtensionSnapshot;
    /**
     * Discover the ambient extensions (agent dir, project, settings) the way a
     * `pi` process would. False loads only `extensionPaths` and `hooks`.
     */
    ambientExtensions: boolean;
    hooks: ChildHookExtension[];
    noSkills: boolean;
    noContextFiles: boolean;
    systemPrompt?: string;
    appendSystemPrompt?: string;
    /**
     * Environment values that extensions loaded into the child read from
     * `process.env`. Applied to the hosting process while the session is created
     * and its extensions load and start; launches in one process take that
     * window one at a time. An undefined value removes the variable.
     */
    processEnv?: Record<string, string | undefined>;
    /** The typed runtime config the hooks were built from; informational for factories. */
    runtime: ChildRuntimeConfig;
    onExtensionError?: (error: ChildSessionExtensionError) => void;
}
export interface ChildSession {
    subscribe(listener: (event: ChildSessionEvent) => void): () => void;
    /** Resolves when the run ends, including after abort. */
    prompt(text: string): Promise<void>;
    steer(text: string): Promise<void>;
    followUp(text: string): Promise<void>;
    abort(): Promise<void>;
    /** Emits `session_shutdown` to the child's extensions and disposes the session; resolves once that shutdown work is done. */
    dispose(): Promise<void>;
    /** True while Pi still has steering or follow-up input that has not started a turn. */
    hasQueuedMessages?(): boolean;
    readonly messages: readonly AgentMessage[];
    readonly sessionFile: string | undefined;
    readonly sessionId: string;
    readonly modelId: string | undefined;
    readonly contextWindow?: number;
    readonly machineEvidence?: {
        machineId: string;
        initial?: HerdrRemoteGitStatus;
        final?: HerdrRemoteGitStatus;
    };
    /** Event-updated pane-native status; reading it performs no network work. */
    readonly placementSnapshot?: unknown;
    /** Set by the foreground host once the run detached; `factory.dispose()` leaves such children running. */
    detached?: boolean;
    /** Set by `factory.dispose()` before it aborts the child, so the host can report the stop truthfully. */
    shutDown?: boolean;
}
export declare function childSessionHasQueuedMessages(session: ChildSession | undefined): boolean;
export interface ChildSessionFactory {
    create(launch: ChildSessionLaunch): Promise<ChildSession>;
    /** Abort and dispose every live attached child; detached children keep running and hold the shared runtime. */
    dispose(): Promise<void>;
}
export type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
export interface DefaultChildSessionFactoryOptions {
    /**
     * Loads the pi package the sessions are created from. The parent process
     * uses the host's in-process module; the detached runner imports the
     * installed package by absolute path.
     */
    loadPiCodingAgent?: () => Promise<PiCodingAgentModule>;
    /** Upper bound on a disposed child's `session_shutdown` handlers before the session is dropped anyway. */
    shutdownTimeoutMs?: number;
    /** Upper bound on the wait for selected built-in MCP tools to register after the session starts. */
    builtinMcpToolWaitMs?: number;
}
type ModelRuntimeInstance = Awaited<ReturnType<PiCodingAgentModule["ModelRuntime"]["create"]>>;
export type ParentProviderRegistry = Pick<ModelRuntimeInstance, "getRegisteredProviderIds" | "getRegisteredProviderConfig" | "getRegisteredNativeProvider">;
/**
 * Load the host-owned pi-coding-agent module by absolute package entry so a
 * child cannot resolve an extension-owned copy. Root precedence is the running
 * host, an explicit override, then the install tree. Once any root is selected,
 * its manifest, package identity, entry, and import must all succeed; the bare
 * specifier is used only when no root resolves.
 */
export declare function loadHostPiCodingAgent(): Promise<PiCodingAgentModule>;
/**
 * Default factory: detached/background sessions retain the existing shared
 * runtime; each parent-bound foreground launch gets an isolated runtime.
 */
export declare function createDefaultChildSessionFactory(options?: DefaultChildSessionFactoryOptions): ChildSessionFactory;
/** The process-wide factory foreground runs use unless a run passes its own. */
export declare function childSessionFactory(): ChildSessionFactory;
/** Default factory including pane-native placement; detached runners use the same boundary. */
export declare function createPlacementChildSessionFactory(options?: DefaultChildSessionFactoryOptions): ChildSessionFactory;
/**
 * Replace the process-wide factory. Tests install a scripted factory; passing
 * undefined restores the default on next use.
 */
export declare function setChildSessionFactory(factory: ChildSessionFactory | undefined): void;
/**
 * Module path the detached background runner imports its child session factory
 * from. Tests point it at a scripted factory; production launches leave it
 * unset and the runner creates real sessions from the installed pi package.
 */
export declare function childSessionFactoryModule(): string | undefined;
export declare function setChildSessionFactoryModule(modulePath: string | undefined): void;
/** Abort and dispose every live in-process child and release the shared runtime. */
export declare function disposeChildSessions(): Promise<void>;
export {};
//# sourceMappingURL=child-session.d.ts.map