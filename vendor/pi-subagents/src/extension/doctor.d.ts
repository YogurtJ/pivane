import { discoverAgentsAll } from "../agents/agents.ts";
import { diagnoseIntercomBridge } from "../intercom/intercom-bridge.ts";
import { discoverAvailableSkills } from "../agents/skills.ts";
import { type ExtensionConfig, type SubagentState } from "../shared/types.ts";
interface DoctorPaths {
    tempRootDir: string;
    asyncDir: string;
    resultsDir: string;
    chainRunsDir: string;
}
interface DoctorDeps {
    isAsyncAvailable: () => boolean;
    discoverAgentsAll: typeof discoverAgentsAll;
    discoverAvailableSkills: typeof discoverAvailableSkills;
    diagnoseIntercomBridge: typeof diagnoseIntercomBridge;
}
interface DoctorReportInput {
    cwd: string;
    config: ExtensionConfig;
    state: SubagentState;
    context?: "fresh" | "fork";
    requestedSessionDir?: string;
    currentSessionFile?: string | null;
    currentSessionId?: string | null;
    orchestratorTarget?: string;
    sessionError?: string;
    expandTilde?: (value: string) => string;
    paths?: DoctorPaths;
    deps?: Partial<DoctorDeps>;
}
export declare function buildDoctorReport(input: DoctorReportInput): string;
export {};
//# sourceMappingURL=doctor.d.ts.map