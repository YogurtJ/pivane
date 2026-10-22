interface AsyncOverrideParams {
    async?: boolean;
    clarify?: boolean;
    foregroundOnly?: boolean;
}
export declare function applyForceTopLevelAsyncOverride<T extends AsyncOverrideParams>(params: T, depth: number, forceTopLevelAsync: boolean): T;
export {};
