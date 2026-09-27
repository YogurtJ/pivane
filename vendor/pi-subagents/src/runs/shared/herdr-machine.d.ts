import type { ExternalProcessStatus, HerdrMachineReference } from "../../shared/types.ts";
import type { runExternalCli } from "./external-cli-runner.ts";
export { shellQuoteRemote as shellQuote } from "./herdr-connection.ts";
/** The local ssh process gets only what ssh itself needs; remote runs use the machine's own credentials. */
export declare const HERDR_SSH_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK"];
type RunExternalCliInput = Parameters<typeof runExternalCli>[0];
interface MachineSettingsEntry {
    cwd?: string;
    env?: Record<string, string>;
}
export interface ResolveHerdrMachinePlacementInput {
    /** Profile id or label as typed by the operator. */
    machine: string;
    /** Local directory whose project settings hold `subagents.machines`. */
    cwd: string;
    /** Launch cwd: absolute or `~` paths are remote paths as given; relative paths join the configured machine root. */
    stepCwd?: string;
    env?: NodeJS.ProcessEnv;
    /** Test seam: catalog JSON instead of spawning `herdr machine list --json`. */
    catalogJson?: string;
    /** Test seam: settings entry instead of reading settings files. */
    settings?: MachineSettingsEntry;
    herdrBin?: string;
}
export interface HerdrMachinePlacement {
    machine: HerdrMachineReference;
    /** Opt-in `subagents.machines.<name>.env`, exported in front of the remote command. */
    env?: Record<string, string>;
}
export interface PreparedHerdrMachineExternalCliRun {
    input: RunExternalCliInput;
    decorateProcess(process: ExternalProcessStatus): ExternalProcessStatus;
}
export declare function resolveHerdrMachinePlacement(input: ResolveHerdrMachinePlacementInput): HerdrMachinePlacement;
export declare function formatHerdrMachineRunnerUnsupported(input: {
    machine?: string;
    agentName: string;
    runnerType?: string;
    adapter?: string;
    worktree?: boolean;
}): string | undefined;
/** Legacy local-child SSH wrapping is intentionally unavailable after the pane-native cut-over. */
export declare function prepareHerdrMachineExternalCliRun(input: RunExternalCliInput, placement: HerdrMachinePlacement | undefined, _options: {
    localCwd: string;
}): PreparedHerdrMachineExternalCliRun;
/** One-line operator hint for a predictable remote failure, matched against error text and the stderr tail. */
export declare function formatHerdrMachineHint(machine: HerdrMachineReference, text: string): string | undefined;
//# sourceMappingURL=herdr-machine.d.ts.map