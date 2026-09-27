import { type ExtensionConfig } from "../shared/types.ts";
export declare function resolveScheduledStoreRoot(value: string): string;
export declare function getConfigPath(): string;
export declare function saveConfig(config: ExtensionConfig, configPath?: string): void;
export declare function updateConfig(updater: (config: ExtensionConfig) => ExtensionConfig): ExtensionConfig;
export declare function resolveAsyncByDefault(config: Pick<ExtensionConfig, "asyncByDefault">): boolean;
export declare function loadConfig(): ExtensionConfig;
//# sourceMappingURL=config.d.ts.map