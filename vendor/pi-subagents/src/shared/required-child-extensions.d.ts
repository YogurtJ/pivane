export interface RequiredChildExtension {
    /** Safe host-owned identity exposed in launch evidence. */
    id: string;
    /** Existing importable module path. Snapshotted to its canonical absolute path. */
    path: string;
}
export interface RegisterRequiredChildExtensionsInput {
    sessionId: string;
    extensions: readonly RequiredChildExtension[];
    /** Reject launches whose runner or machine placement cannot load these extensions, instead of dropping them. */
    requireForAllRunners?: boolean;
}
export interface RequiredChildExtensionRegistration {
    dispose(): void;
}
/** Registration stamps `requireForAllRunners` on each entry so every carrier of the snapshot retains it. */
export type RequiredChildExtensionSnapshot = ReadonlyArray<Readonly<RequiredChildExtension & {
    requireForAllRunners?: true;
}>>;
/** Validate and freeze a snapshot; registration canonicalizes once, while retained launches preserve that identity. */
export declare function snapshotRequiredChildExtensions(value: unknown, label?: string, canonicalizeFiles?: boolean): RequiredChildExtensionSnapshot;
/** Register one immutable host-required extension snapshot for a parent session. */
export declare function registerRequiredChildExtensions(input: RegisterRequiredChildExtensionsInput): RequiredChildExtensionRegistration;
export declare function resolveRequiredChildExtensions(sessionId: string | undefined): RequiredChildExtensionSnapshot;
/** Reject a non-native runner or machine placement when any given snapshot has a `requireForAllRunners` entry. */
export declare function assertRequiredChildExtensionsAdmitted(snapshots: ReadonlyArray<RequiredChildExtensionSnapshot | undefined>, launch: {
    agent: string;
    runnerType?: string;
    machine?: string;
}): void;
export declare function hasMandatoryRequiredChildExtensions(snapshot: RequiredChildExtensionSnapshot | undefined): snapshot is RequiredChildExtensionSnapshot;
/** Persist a run's mandatory snapshot so append-step admits against it; writes nothing without a mandatory entry. */
export declare function writeRetainedRequiredChildExtensions(asyncDir: string, snapshot: RequiredChildExtensionSnapshot): void;
export declare function readRetainedRequiredChildExtensions(asyncDir: string): RequiredChildExtensionSnapshot | undefined;
//# sourceMappingURL=required-child-extensions.d.ts.map