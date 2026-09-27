import type { ProcessTreeTerminal } from "../../shared/types.ts";
export interface SetupCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    /** Worktrunk uses 128 KiB; Git and hooks use spawnSync's 1 MiB default. */
    maxBuffer?: number;
    signal?: AbortSignal;
    deadlineAt?: number;
    /** Only the existing configured setup-hook timeout, not a new Git budget. */
    hookTimeoutMs?: number;
    /** Read-only probes may define negative answers as completed commands. */
    acceptedExitCodes?: readonly number[];
    onSpawn?: (process: {
        pid: number;
        processGroupId?: number;
    }) => void;
}
export interface SetupCommandResult {
    stdout: string;
    stdoutBuffer: Buffer;
    stderr: string;
    status: number | null;
    signal: NodeJS.Signals | null;
    error?: Error;
    pid?: number;
    processGroupId?: number;
    /** Absent on normal completion: trusted command completion is NOT tree proof. */
    processTree?: ProcessTreeTerminal;
    outputIncomplete: boolean;
}
/**
 * Setup I/O only. Commands must await their descendants before reporting success.
 * Exit 0 + natural close + complete output still requires caller JSON/path validation.
 * Invalid output is NOT accepted completion: retain unknown ownership, never signal
 * this completed command's PID later. Callers own compensation and admission.
 */
export declare function runSetupCommand(command: string, args: string[], options: SetupCommandOptions): Promise<SetupCommandResult>;
//# sourceMappingURL=worktree-setup-command.d.ts.map