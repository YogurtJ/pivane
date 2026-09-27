export declare const JITI_ALIAS_ENV = "JITI_ALIAS";
/** Specifiers the runner's import graph may use, with the package and export subpath each resolves to. */
export declare const HOST_PEER_ALIASES: ReadonlyArray<{
    specifier: string;
    pkg: string;
    subpath: string;
}>;
/** Resolve `subpath` of the package at `packageDir` through its `exports` map (with `*` patterns) or `main`. */
export declare function resolvePackageSubpath(packageDir: string, subpath: string): string | undefined;
/** Find `pkg` as the pi package itself, one of its dependencies, or a sibling in a hoisted install. */
export declare function findHostPeerPackageDir(piPackageRoot: string, pkg: string): string | undefined;
/** The alias map the runner needs, or the specifiers that could not be resolved. */
export declare function resolveHostPeerAliases(piPackageRoot: string): {
    aliases: Record<string, string>;
    missing: string[];
};
//# sourceMappingURL=runner-aliases.d.ts.map