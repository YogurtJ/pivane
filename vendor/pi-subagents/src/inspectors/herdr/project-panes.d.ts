import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Details, SubagentState } from "../../shared/types.ts";
import { type HerdrClient, type HerdrErrorCode } from "./client.ts";
export declare const HERDR_PROJECT_PANE_ACTIONS: readonly ["project.open", "project.status", "project.close"];
export type HerdrProjectPaneAction = typeof HERDR_PROJECT_PANE_ACTIONS[number];
/** Versioned public contract exported through `pi-subagents/project-panes`. */
export declare const PROJECT_PANES_API_VERSION: 1;
export declare const PROJECT_PANE_TRUST_STATUS: "human-verification-required";
export interface HerdrProjectPaneBinding {
    schemaVersion: 1;
    kind: "herdr-project-pane";
    projectRoot: string;
    paneId: string;
    openedAt: string;
    lastFocusedAt?: string;
    herdrVersion?: string;
    command: string;
    startupMessage?: string;
}
export interface ProjectPaneRuntime {
    paneId: string;
    agent?: string;
    agentStatus: string;
    cwd?: string;
    foregroundCwd?: string;
    focused?: boolean;
    tabId?: string;
    workspaceId?: string;
    summary?: string;
    terminalTitle?: string;
}
export type ProjectPaneErrorCode = HerdrErrorCode | "INVALID_PROJECT_ROOT" | "INVALID_PANE_RESPONSE" | "INVALID_BINDING" | "BINDING_READ_FAILED" | "BINDING_WRITE_FAILED" | "BINDING_REMOVE_FAILED" | "PANE_FOCUS_UNSUPPORTED" | "PANE_NOT_IDLE" | "PANE_OWNERSHIP_UNVERIFIED";
export interface ProjectPaneError {
    code: ProjectPaneErrorCode;
    message: string;
    projectRoot?: string;
    bindingPath?: string;
    details?: unknown;
}
export type ProjectPaneResult<T> = {
    ok: true;
    data: T;
} | {
    ok: false;
    error: ProjectPaneError;
};
interface ProjectPaneCommonData {
    apiVersion: typeof PROJECT_PANES_API_VERSION;
    projectRoot: string;
    bindingPath: string;
    trust: typeof PROJECT_PANE_TRUST_STATUS;
}
export interface OpenProjectPaneData extends ProjectPaneCommonData {
    disposition: "opened" | "already-open";
    binding: HerdrProjectPaneBinding;
    runtime?: ProjectPaneRuntime;
}
export interface ProjectPaneStatusData extends ProjectPaneCommonData {
    state: "absent" | "open" | "stale";
    binding?: HerdrProjectPaneBinding;
    runtime?: ProjectPaneRuntime;
    ownership: "verified" | "unknown" | "mismatch";
    safeToClose: boolean;
    staleReason?: {
        code: HerdrErrorCode;
        message: string;
    };
}
export interface CloseProjectPaneData extends ProjectPaneCommonData {
    disposition: "closed" | "absent" | "stale-binding-removed";
    binding?: HerdrProjectPaneBinding;
    runtime?: ProjectPaneRuntime;
}
export interface FocusProjectPaneData extends ProjectPaneCommonData {
    binding: HerdrProjectPaneBinding;
    runtime: ProjectPaneRuntime;
    ownership: "verified" | "unknown" | "mismatch";
    focused: {
        paneId: string;
        tabId?: string;
        workspaceId?: string;
    };
}
export interface OpenProjectPaneOptions {
    cwd: string;
    message?: string;
    focus?: boolean;
    signal?: AbortSignal;
}
export interface GetProjectPaneStatusOptions {
    cwd: string;
    signal?: AbortSignal;
}
export interface CloseProjectPaneOptions {
    cwd: string;
    /** Fail closed unless Herdr explicitly reports the owning Pi pane as idle. */
    requireIdle?: boolean;
    signal?: AbortSignal;
}
export type ProjectPaneCommandClient = Pick<HerdrClient, "run">;
export interface ProjectPaneManagerOptions {
    client?: ProjectPaneCommandClient;
    now?: () => Date;
}
export interface ProjectPaneManager {
    open(options: OpenProjectPaneOptions): Promise<ProjectPaneResult<OpenProjectPaneData>>;
    status(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<ProjectPaneStatusData>>;
    focus(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<FocusProjectPaneData>>;
    close(options: CloseProjectPaneOptions): Promise<ProjectPaneResult<CloseProjectPaneData>>;
}
interface ProjectPaneParams {
    cwd?: string;
    message?: string;
    focus?: boolean;
}
interface ProjectPaneDeps {
    cwd: string;
    state?: SubagentState;
    client?: HerdrClient;
    signal?: AbortSignal;
    now?: () => Date;
}
export declare function projectPaneBindingPath(projectRoot: string): string;
export declare function listHerdrProjectPaneRoots(ownerRoot: string): string[];
/** Legacy model-facing reader; preserves the original required-field-only parsing contract. */
export declare function readHerdrProjectPaneBinding(projectRoot: string): HerdrProjectPaneBinding | undefined;
/** Strict public reader for extension integrations. */
export declare function readProjectPaneBinding(projectRoot: string): ProjectPaneResult<HerdrProjectPaneBinding | undefined>;
export declare function restoreHerdrProjectPaneSnapshots(state: SubagentState, projectRoots: Iterable<string>, now?: number): void;
export declare function createProjectPaneManager(options?: ProjectPaneManagerOptions): ProjectPaneManager;
export declare function openProjectPane(options: OpenProjectPaneOptions): Promise<ProjectPaneResult<OpenProjectPaneData>>;
export declare function getProjectPaneStatus(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<ProjectPaneStatusData>>;
export declare function closeProjectPane(options: CloseProjectPaneOptions): Promise<ProjectPaneResult<CloseProjectPaneData>>;
export declare function focusProjectPane(options: GetProjectPaneStatusOptions): Promise<ProjectPaneResult<FocusProjectPaneData>>;
export declare function handleHerdrProjectPaneAction(action: HerdrProjectPaneAction, params: ProjectPaneParams, deps: ProjectPaneDeps): Promise<AgentToolResult<Details>>;
export {};
//# sourceMappingURL=project-panes.d.ts.map