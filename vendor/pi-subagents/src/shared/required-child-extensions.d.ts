export interface RequiredChildExtension {
    /** Safe host-owned identity exposed in launch evidence. */
    id: string;
    /** Existing importable module path. Snapshotted to its canonical absolute path. */
    path: string;
}
export interface RegisterRequiredChildExtensionsInput {
    sessionId: string;
    extensions: readonly RequiredChildExtension[];
}
export interface RequiredChildExtensionRegistration {
    dispose(): void;
}
export type RequiredChildExtensionSnapshot = ReadonlyArray<Readonly<RequiredChildExtension>>;
/** Validate and freeze a snapshot; registration canonicalizes once, while retained launches preserve that identity. */
export declare function snapshotRequiredChildExtensions(value: unknown, label?: string, canonicalizeFiles?: boolean): RequiredChildExtensionSnapshot;
/** Register one immutable host-required extension snapshot for a parent session. */
export declare function registerRequiredChildExtensions(input: RegisterRequiredChildExtensionsInput): RequiredChildExtensionRegistration;
export declare function resolveRequiredChildExtensions(sessionId: string | undefined): RequiredChildExtensionSnapshot;
//# sourceMappingURL=required-child-extensions.d.ts.map