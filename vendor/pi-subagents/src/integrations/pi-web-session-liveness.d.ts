import type { NestedRouteInfo, SubagentState } from "../shared/types.ts";
export declare const PI_WEB_SESSION_LIVENESS_REGISTRY_KEY = "@agegr/pi-web/session-liveness/v1";
interface PiWebSessionLivenessProvider {
    name: string;
    sessionId: string;
    sessionFile?: string;
    isActive(): boolean;
}
type SessionLivenessRegistration = Omit<PiWebSessionLivenessProvider, "name">;
export interface PiWebSessionLivenessHandle {
    /** True only when the compatible host accepted the provider registration. */
    registered: boolean;
    release: () => void;
}
type LiveWorkState = Pick<SubagentState, "asyncJobs" | "foregroundControls" | "retainedForegroundNestedRoutes">;
export declare function retainLiveForegroundNestedRoute(state: Pick<SubagentState, "retainedForegroundNestedRoutes">, route: NestedRouteInfo): boolean;
export declare function hasLiveSubagentWork(state: LiveWorkState): boolean;
export declare function registerPiWebSessionLiveness(registration: SessionLivenessRegistration): PiWebSessionLivenessHandle;
export {};
//# sourceMappingURL=pi-web-session-liveness.d.ts.map