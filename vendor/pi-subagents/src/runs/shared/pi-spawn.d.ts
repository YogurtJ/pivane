export declare const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export declare const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export declare const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";
export declare function findPiPackageRootFromEntry(entryPoint: string, deps?: Pick<PiSpawnDeps, "platform" | "existsSync" | "readFileSync">): string | undefined;
export declare function resolveInstalledPiPackageRoot(): string | undefined;
export declare function resolvePiPackageRoot(): string | undefined;
export interface PiSpawnDeps {
    platform?: NodeJS.Platform;
    execPath?: string;
    argv1?: string;
    bunVersion?: string;
    existsSync?: (filePath: string) => boolean;
    realpathSync?: (filePath: string) => string;
    readFileSync?: (filePath: string, encoding: "utf-8") => string;
    resolvePackageJson?: () => string;
    resolvePackageEntry?: () => string;
    piPackageRoot?: string;
    env?: NodeJS.ProcessEnv;
}
export type RunningPiPackageRoot = {
    root: string;
    source: "argv" | "PI_PACKAGE_DIR" | "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT" | "bun-adjacent" | "bun-share";
} | {
    reason: string;
};
/** Resolve only package roots that can be attributed to the process that owns this session. */
export declare function resolveRunningPiPackageRoot(deps?: PiSpawnDeps): RunningPiPackageRoot | undefined;
/** Compiled Pi's entrypoint is virtual; execPath is the real (possibly renamed) image. */
export declare function resolveBunPiExecutable(deps?: PiSpawnDeps): string | undefined;
interface PiSpawnCommand {
    command: string;
    args: string[];
}
export declare function resolvePiCliScript(deps?: PiSpawnDeps): string | undefined;
export declare function getPiSpawnCommand(args: string[], deps?: PiSpawnDeps): PiSpawnCommand;
export {};
//# sourceMappingURL=pi-spawn.d.ts.map