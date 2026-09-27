import * as fs from "node:fs";
type AccessibleDirFs = Pick<typeof fs, "accessSync" | "mkdirSync">;
type AccessibleDirOptions = {
    fs?: AccessibleDirFs;
    retryDirectoryErrors?: boolean;
    retryDelaysMs?: readonly number[];
    wait?: (delayMs: number) => void;
    pid?: number;
};
export declare function ensureAccessibleDir(dirPath: string, options?: AccessibleDirOptions): string;
export {};
//# sourceMappingURL=accessible-dir.d.ts.map