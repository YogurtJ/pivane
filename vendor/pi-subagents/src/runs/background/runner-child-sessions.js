var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/**
 * Child session factory for the detached async runner.
 *
 * The runner imports `@earendil-works/pi-coding-agent` like the parent does;
 * the parent aliases that specifier (and the other host peer packages) to the
 * installed pi package through `JITI_ALIAS` when it spawns the runner, see
 * `runner-aliases.ts`. Tests replace the factory with a scripted one by
 * naming a module in the runner config. The binary bootstrap supplies its
 * embedded SDK through the default factory's existing loader option instead.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createPlacementChildSessionFactory } from "../shared/child-session.js";
function isChildSessionFactory(value) {
    return Boolean(value) && typeof value === "object" && typeof value.create === "function" && typeof value.dispose === "function";
}
export async function loadRunnerChildSessionFactory(config, options) {
    if (!config.childSessionFactoryModule)
        return createPlacementChildSessionFactory(options);
    const loaded = await import(__rewriteRelativeImportExtension(pathToFileURL(path.resolve(config.childSessionFactoryModule)).href));
    const candidate = typeof loaded.default === "function" ? loaded.default() : loaded.default;
    if (!isChildSessionFactory(candidate)) {
        throw new Error(`Child session factory module '${config.childSessionFactoryModule}' must default-export a ChildSessionFactory or a function returning one.`);
    }
    return candidate;
}
//# sourceMappingURL=runner-child-sessions.js.map