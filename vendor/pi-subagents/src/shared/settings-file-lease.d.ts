/** Physical file a settings path writes to, following file and directory links (including a dangling file link). */
export declare function resolveSettingsWriteTarget(filePath: string): string;
/** Hold the physical settings file's lease for a whole read-modify-write. */
export declare function withSettingsFileLease<T>(filePath: string, action: () => T): T;
//# sourceMappingURL=settings-file-lease.d.ts.map