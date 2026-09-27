export declare const PI_SUBAGENT_EXTENSION_BINDINGS_ENV = "PI_SUBAGENT_EXTENSION_BINDINGS";
export declare const MAX_EXTENSION_BINDING_NAMESPACES = 16;
export declare const MAX_EXTENSION_BINDINGS_BYTES: number;
export declare const MAX_EXTENSION_BINDINGS_DEPTH = 16;
export declare const MAX_EXTENSION_BINDINGS_PROPERTIES = 256;
export type ExtensionBindingJson = null | boolean | number | string | ReadonlyArray<ExtensionBindingJson> | {
    readonly [key: string]: ExtensionBindingJson;
};
export type ExtensionBindings = Readonly<Record<string, ExtensionBindingJson>>;
export interface NormalizedExtensionBindings {
    value: ExtensionBindings;
    json: string;
}
export declare function normalizeExtensionBindings(input: unknown): NormalizedExtensionBindings | undefined;
export declare function encodeExtensionBindings(input: ExtensionBindings | undefined): string | undefined;
export declare function omitExtensionBindingsEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
//# sourceMappingURL=extension-bindings.d.ts.map