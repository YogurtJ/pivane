export type FileWatchPurpose = "result-delivery" | "supervisor-channel" | "async-job-tracker" | "retained-nested-route-tracker" | "runner-control-inbox" | "child-steering-inbox";
export declare function shouldUseNativeFsWatch(_purpose: FileWatchPurpose, platform?: NodeJS.Platform): boolean;
//# sourceMappingURL=watch-strategy.d.ts.map