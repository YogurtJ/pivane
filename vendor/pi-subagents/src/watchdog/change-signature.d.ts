export interface WatchdogRepoChangeSignature {
    root: string;
    key: string;
    changedPaths: string[];
}
export declare function computeWatchdogRepoChangeSignature(cwd: string): WatchdogRepoChangeSignature | undefined;
export declare function eventIndicatesRepoEdit(event: unknown): boolean;
//# sourceMappingURL=change-signature.d.ts.map