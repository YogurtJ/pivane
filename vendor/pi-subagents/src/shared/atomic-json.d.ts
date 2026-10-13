import * as fs from "node:fs";
type AtomicJsonFs = Pick<typeof fs, "mkdirSync" | "writeFileSync" | "renameSync" | "rmSync">;
type AtomicJsonWriterOptions = {
    fs?: AtomicJsonFs;
    now?: () => number;
    pid?: number;
    random?: () => number;
    mode?: number;
    retryRenameErrors?: boolean;
    retryDirectoryErrors?: boolean;
    ignoreCleanupErrorAfterSuccess?: boolean;
    retryDelaysMs?: readonly number[];
    wait?: (delayMs: number) => void;
};
/** `beforeRename` runs after the payload is written to its temporary file and before it appears at `filePath`. */
export declare function createAtomicJsonWriter(options?: AtomicJsonWriterOptions): (filePath: string, payload: object, beforeRename?: () => void) => void;
export declare const writeAtomicJson: (filePath: string, payload: object, beforeRename?: () => void) => void;
export declare const writePrivateAtomicJson: (filePath: string, payload: object, beforeRename?: () => void) => void;
export {};
//# sourceMappingURL=atomic-json.d.ts.map