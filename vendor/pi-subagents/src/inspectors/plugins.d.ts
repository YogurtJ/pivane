import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { InspectorPlugin } from "./types.ts";
type InspectorOwner = Pick<ExtensionAPI, "events">;
/** Built-ins retain host preference; external providers follow registration order. */
export declare function getInspectorPlugins(pi: InspectorOwner): readonly InspectorPlugin[];
/** Registrations live while any owner runtime listens on this bus; child runtimes use their own bus. */
export declare function registerInspectorEventListener(pi: InspectorOwner): () => void;
export {};
//# sourceMappingURL=plugins.d.ts.map