export declare const PI_CODING_AGENT_PACKAGE = "@earendil-works/pi-coding-agent";
export declare const PI_SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
export declare function findPiPackageRootFromEntry(entryPoint: string): string | undefined;
export declare function resolveInstalledPiPackageRoot(): string | undefined;
export declare function resolvePiPackageRoot(entry?: string | undefined): string | undefined;
/** Resolve only the canonical host entry's local dependency graph, not NODE_PATH/global stores. */
export declare function resolveHostDependencyPiPackageRoot(entry?: string | undefined): string | undefined;
/** One SDK root for foreground imports and detached peer aliases; never retry a selected root. */
export declare function resolveHostPiPackageRoot(deps?: PiSpawnDeps): string | undefined;
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
/** Compiled Pi's entrypoint is virtual; execPath is the real (possibly renamed) image. */
export declare function resolveBunPiExecutable(deps?: PiSpawnDeps): string | undefined;
interface PiSpawnCommand {
    command: string;
    args: string[];
}
export declare function resolvePiCliScript(deps?: PiSpawnDeps): string | undefined;
export declare function getPiSpawnCommand(args: string[], deps?: PiSpawnDeps): PiSpawnCommand;
export {};
