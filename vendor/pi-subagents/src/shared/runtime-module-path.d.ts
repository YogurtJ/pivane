/** Every extension a sibling runtime module may be published with: compiled `.js` first, source `.ts`. */
export declare const RUNTIME_MODULE_EXTENSIONS: readonly [".js", ".ts"];
/**
 * Which extension a sibling runtime module has on disk now. An in-place package
 * update can swap the `.ts` source layout for the compiled `.js` layout under a
 * running process, so the running module's own extension is not reliable.
 */
export declare function resolveRuntimeModuleExtension(dir: string, basename: string): string;
/** Absolute, normalized path to a sibling runtime module that exists on disk. */
export declare function resolveRuntimeModulePath(dir: string, basename: string): string;
//# sourceMappingURL=runtime-module-path.d.ts.map