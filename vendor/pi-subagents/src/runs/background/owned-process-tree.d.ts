import type { ProcessTreeTerminal } from "../../shared/types.ts";
/** Owns one writer process group and arbitrates its cleanup exactly once. */
export interface OwnedProcessTreeController {
    terminate(): Promise<ProcessTreeTerminal>;
    finishAfterWriterClose(): Promise<ProcessTreeTerminal>;
}
export declare function createOwnedProcessTreeController(pid: number, options?: {
    termGraceMs?: number;
    killVerifyMs?: number;
}): OwnedProcessTreeController;
//# sourceMappingURL=owned-process-tree.d.ts.map