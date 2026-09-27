type SubagentExecutionContext = "fresh" | "fork";
interface BranchSessionEntry {
    type: string;
    id?: string;
    cwd?: string;
    parentId?: string | null;
    timestamp?: string;
    targetId?: string;
    replacement?: {
        content?: unknown;
    } | null;
    message?: {
        role?: string;
        content?: unknown;
        provider?: string;
        api?: string;
        model?: string;
    };
}
interface BranchSessionManager {
    createBranchedSession(leafId: string): string | undefined;
    getHeader?: () => BranchSessionEntry | null;
    getEntries?: () => BranchSessionEntry[];
}
interface ForkableSessionManager {
    getSessionFile(): string | undefined;
    getLeafId(): string | null;
    getSessionDir?(): string;
    openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
}
interface ForkContextResolverOptions {
    openSession?: (path: string, sessionDir?: string) => BranchSessionManager;
    /** Rewrite a created fork before its path can be used to spawn a child. */
    pruneSession?: (sessionFile: string) => Promise<void>;
}
interface ForkContextResolver {
    prepareSessionForIndex(index?: number): Promise<void>;
    sessionFileForIndex(index?: number): string | undefined;
}
export declare function resolveSubagentContext(value: unknown): SubagentExecutionContext;
export interface PreferredForkAvailability {
    getSessionFile(): string | undefined;
    getLeafId?: () => string | null;
}
export interface PreferredForkSnapshot {
    parentSessionFile?: string | null;
    leafId?: string | null;
}
export interface SubagentLaunchContextInput {
    explicitContext?: SubagentExecutionContext;
    agentDefaultContext?: SubagentExecutionContext;
    defaultSubagentContext?: SubagentExecutionContext;
    canUseImplicitFork: boolean;
}
/** Resolve the actual launch context from explicit, global, and agent preferences. */
export declare function resolveSubagentLaunchContext(input: SubagentLaunchContextInput): SubagentExecutionContext;
/** True when an implicit `defaultContext: fork` can create a real branch now.
 * Explicit `context: "fork"` stays strict and does not use this preference. */
export declare function canPreferFork(sessionManager: PreferredForkAvailability): boolean;
export declare function canPreferForkFromSnapshot(input: PreferredForkSnapshot): boolean;
export declare function createForkContextResolver(sessionManager: ForkableSessionManager, requestedContext: unknown, options?: ForkContextResolverOptions): ForkContextResolver;
export {};
//# sourceMappingURL=fork-context.d.ts.map