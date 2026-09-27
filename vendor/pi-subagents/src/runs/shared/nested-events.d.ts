import { type AsyncJobState, type AsyncStatus, type NestedRouteInfo, type NestedRunSummary, type SubagentRunMode, type SubagentState } from "../../shared/types.ts";
import { type NestedPathEntry } from "./nested-path.ts";
export declare const NESTED_EVENTS_DIR: string;
type NestedStatusEventType = "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed";
type NestedControlResultEventType = "subagent.nested.control-result";
export type NestedRoute = NestedRouteInfo;
export interface NestedEventRecord {
    type: NestedStatusEventType;
    ts: number;
    rootRunId: string;
    parentRunId: string;
    parentStepIndex?: number;
    capabilityToken: string;
    child: NestedRunSummary;
}
export interface NestedControlResultRecord {
    type: NestedControlResultEventType;
    ts: number;
    rootRunId: string;
    capabilityToken: string;
    requestId: string;
    targetRunId: string;
    ok: boolean;
    message: string;
}
export interface NestedControlRequestRecord {
    type: "subagent.nested.control-request";
    ts: number;
    rootRunId: string;
    capabilityToken: string;
    requestId: string;
    targetRunId: string;
    action: "interrupt" | "resume";
    message?: string;
}
export interface NestedRegistry {
    rootRunId: string;
    updatedAt: number;
    children: NestedRunSummary[];
    processedEvents: string[];
}
export declare function isSafeNestedId(value: unknown): value is string;
export declare function assertSafeNestedId(label: string, value: string): void;
export declare function createNestedRoute(rootRunId: string): NestedRoute;
/** Validate a route handed to an in-process child against its on-disk metadata. */
export declare function resolveNestedRoute(route: NestedRoute): NestedRoute;
export declare function resolveInheritedNestedRoute(route: NestedRoute): NestedRoute | undefined;
export interface NestedParentAddress {
    parentRunId: string;
    parentStepIndex?: number;
    depth: number;
    path: NestedPathEntry[];
}
/** The nested route an executor inherited from its own child runtime, validated against disk. */
export declare function inheritedNestedRouteOf(runtime: {
    nestedRoute?: NestedRoute;
} | undefined): NestedRoute | undefined;
/** The executor's own position in the nested run tree, from its child runtime. */
export declare function inheritedNestedParentAddressOf(runtime: {
    nestedParent?: {
        parentRunId: string;
        parentChildIndex?: number;
        depth: number;
        path: NestedPathEntry[];
    };
} | undefined): NestedParentAddress | undefined;
export declare function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined;
export declare function sanitizeSummary(input: unknown, depth?: number): NestedRunSummary | undefined;
export declare function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[];
export declare function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry;
export declare function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined;
export declare function buildNestedRouteIndex(): Map<string, NestedRoute>;
export declare function projectNestedRegistryForRoot(rootRunId: string): NestedRegistry | undefined;
export declare function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined;
export interface NestedRunMatch {
    rootRunId: string;
    route: NestedRoute;
    run: NestedRunSummary;
}
export declare function retainNestedLookupRoute(state: Pick<SubagentState, "currentSessionId" | "retainedNestedLookupRoutes">, route: NestedRouteInfo | undefined, sessionId: string | undefined): void;
export interface NestedRunResolutionScope {
    routes: NestedRoute[];
    descendantOf?: {
        parentRunId: string;
        parentStepIndex?: number;
    };
}
export declare function findNestedRunMatchesById(id: string, options?: {
    prefix?: boolean;
    scope?: NestedRunResolutionScope;
}): NestedRunMatch[];
export declare function findNestedRunById(id: string): {
    rootRunId: string;
    run: NestedRunSummary;
} | undefined;
export declare function readNestedRegistry(route: NestedRoute): NestedRegistry;
export declare function projectNestedEvents(route: NestedRoute): NestedRegistry;
export declare function writeNestedEvent(route: NestedRoute, event: Omit<NestedEventRecord, "rootRunId" | "capabilityToken">): void;
export declare function writeNestedControlRequest(route: NestedRoute, request: Omit<NestedControlRequestRecord, "type" | "rootRunId" | "capabilityToken">): string;
export declare function readNestedControlRequests(route: NestedRoute): Array<NestedControlRequestRecord & {
    filePath: string;
}>;
export declare function writeNestedControlResult(route: NestedRoute, result: Omit<NestedControlResultRecord, "type" | "rootRunId" | "capabilityToken">): void;
export declare function snapshotNestedEventFiles(route: NestedRoute): Set<string>;
export declare function findNestedControlResult(route: NestedRoute, requestId: string, targetRunId: string, ignoredFiles: ReadonlySet<string>): NestedControlResultRecord | undefined;
export declare function readNestedControlResults(route: NestedRoute): NestedControlResultRecord[];
export declare function attachRootChildrenToSteps<T extends {
    children?: NestedRunSummary[];
    index?: number;
}>(rootRunId: string, steps: T[] | undefined, children: NestedRunSummary[] | undefined): void;
export declare function updateAsyncJobNestedProjection(job: AsyncJobState): void;
export declare function updateForegroundNestedProjection(control: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never): void;
export declare function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean;
export declare function nestedSummaryFromAsyncStatus(status: AsyncStatus, asyncDir: string, fallback: {
    id: string;
    parentRunId: string;
    parentStepIndex?: number;
    depth: number;
    path?: Array<{
        runId: string;
        stepIndex?: number;
        agent?: string;
    }>;
    mode?: SubagentRunMode;
    ts: number;
}): NestedRunSummary;
export declare function isTopLevelAsyncDir(asyncDir: string): boolean;
export declare function nestedRunScope(rootRunId: string): {
    asyncDirRoot: string;
    resultsDir: string;
};
export declare function nestedResultsPath(rootRunId: string, id: string): string;
export {};
//# sourceMappingURL=nested-events.d.ts.map