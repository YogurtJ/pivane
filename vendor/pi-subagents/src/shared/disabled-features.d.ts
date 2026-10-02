/**
 * Opt-in feature groups an operator can remove from the parent-facing `subagent` tool.
 * Groups own parameters and actions that enabled features do not need, so hiding them
 * cannot remove a field that enabled behavior still needs. `preflight` is the one shared
 * parameter: it is script-only, so `workflow-scripts` removes it too. Per-call options
 * disable only the per-call override; configured defaults keep applying.
 */
export declare const SUBAGENT_FEATURES: {
    readonly "agent-management": {
        readonly actions: readonly ["create", "update", "delete", "eject", "disable", "enable", "reset", "refine", "refine.show", "refine.rollback"];
        readonly params: readonly ["config"];
    };
    readonly watchdog: {
        readonly actions: readonly ["watchdog.status", "watchdog.check", "watchdog.configure", "watchdog.recommend-model"];
        readonly params: readonly ["scope", "target", "thinking"];
    };
    readonly panes: {
        readonly actions: readonly ["inspector.open", "inspector.command", "inspector.status", "inspector.close", "project.open", "project.status", "project.close"];
        readonly params: readonly ["focus"];
    };
    readonly missions: {
        readonly actions: readonly ["mission.create", "mission.list", "mission.show", "mission.update", "mission.resolve-decision", "mission.attach-run", "mission.close"];
        readonly params: readonly ["mission", "missionUpdate", "missionStatus", "missionScope", "missionId", "runMode", "runStatus", "summary"];
    };
    readonly "lane-management": {
        readonly actions: readonly ["lane.status", "lane.recordMerge", "lane.recordSupersession", "worktree.discard", "worktree.cleanup"];
        readonly params: readonly ["handoffPath", "laneId", "merge", "supersession", "repo", "planId"];
    };
    readonly "spawn-budget-grants": {
        readonly actions: readonly ["grant-spawn-budget"];
        readonly params: readonly ["additional"];
    };
    readonly preflight: {
        readonly actions: readonly [];
        readonly params: readonly ["preflight"];
    };
    readonly "lane-metadata": {
        readonly actions: readonly [];
        readonly params: readonly ["lane"];
    };
    readonly gates: {
        readonly actions: readonly [];
        readonly params: readonly ["gate"];
    };
    readonly "usage-budgets": {
        readonly actions: readonly [];
        readonly params: readonly ["usageBudget"];
    };
    readonly "tool-budgets": {
        readonly actions: readonly [];
        readonly params: readonly ["toolBudget"];
    };
    readonly "control-overrides": {
        readonly actions: readonly [];
        readonly params: readonly ["control"];
    };
    readonly "extension-bindings": {
        readonly actions: readonly [];
        readonly params: readonly ["extensionBindings"];
    };
    readonly "external-machines": {
        readonly actions: readonly [];
        readonly params: readonly ["machine"];
    };
    readonly "workflow-scripts": {
        readonly actions: readonly ["validate"];
        readonly params: readonly ["workflow", "args", "preflight", "globalConcurrencyLimit", "maxSubagentSpawnsPerRun"];
    };
};
export type SubagentFeature = keyof typeof SUBAGENT_FEATURES;
/** Schedules are turned off by `scheduledRuns.enabled: false`, not by `disabledFeatures`. */
export type SubagentSurfaceFeature = SubagentFeature | "schedules";
export declare function validateDisabledFeatures(value: unknown): void;
/** Disabled features, and each disabled parameter and action mapped to the setting that disabled it. */
export interface DisabledFeatureSurface {
    features: ReadonlySet<SubagentSurfaceFeature>;
    params: ReadonlyMap<string, string>;
    actions: ReadonlyMap<string, string>;
}
interface FeatureConfig {
    disabledFeatures?: readonly SubagentFeature[];
    scheduledRuns?: {
        enabled?: boolean;
    };
}
export declare function resolveDisabledFeatureSurface(config: FeatureConfig): DisabledFeatureSurface;
/** Returns why a request uses a disabled feature, or undefined when every requested field is enabled. */
export declare function disabledFeatureUseError(request: object, surface: DisabledFeatureSurface, label?: string): string | undefined;
/** Lists what config disabled, for prepending to static reference docs that describe the full tool. */
export declare function disabledFeatureNotice(surface: DisabledFeatureSurface): string | undefined;
export {};
//# sourceMappingURL=disabled-features.d.ts.map