import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
/**
 * Declares a tool to the model but keeps it out of codemode scripts and other `ctx.executeTool()`
 * callers. These tools need model-issued calls: nested calls hide their progress, block the script
 * on supervisor replies, and drop `terminate`. Pi 0.99 reads `exposure`; the pinned SDK types
 * predate it and older hosts ignore it.
 */
export declare const MODEL_ONLY_TOOL: {
    readonly exposure: "model-only";
};
/** Pi exposes replaced extension contexts as ordinary Errors without a stable code. */
export declare function isStaleExtensionContextError(error: unknown): boolean;
/**
 * Whether the host can render a `ctx.ui.custom()` component. Stock Pi RPC defines `custom` as a
 * no-op stub, so a non-TUI host must declare that it implements the custom-UI contract itself.
 */
export declare function canRenderComponents(ctx: ExtensionContext): boolean;
/** Pi throws this from action methods while extensions are still loading, before it binds the runtime. */
export declare function isUnboundExtensionRuntimeError(error: unknown): boolean;
/** Run a synchronous operation against a cached UI context without leaking replacement errors. */
export declare function withCachedUiContext<T>(ctx: ExtensionContext | null | undefined, onStale: () => void, run: (ctx: ExtensionContext) => T): T | undefined;
//# sourceMappingURL=extension-context.d.ts.map