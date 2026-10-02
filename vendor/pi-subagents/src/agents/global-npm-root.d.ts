/** Optional global package discovery; a failure never prevents local discovery. */
export declare function resolveGlobalNpmRoot(options?: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    timeoutMs?: number;
}): Promise<string | null>;
//# sourceMappingURL=global-npm-root.d.ts.map