// Version-reviewed against Pi Coding Agent 1.0.0's CodemodeModelRuntime and
// createModelGlobals: only these five registry methods cross the script bridge.
function codemodeModelRegistry(registry) {
    // Do not inherit ModelRegistry: its prototype and runtime would expose the
    // original image method. Bind permitted methods for registry private state.
    return Object.freeze(Object.assign(Object.create(null), {
        getModelsOfType: registry.getModelsOfType.bind(registry),
        getAvailableOfType: registry.getAvailableOfType.bind(registry),
        getModelOfType: registry.getModelOfType.bind(registry),
        classify: registry.classify.bind(registry),
        generateImages() {
            throw new Error('models.generateImages() is blocked in Pivane codemode. Use the Pivane media planning and confirmation workflow; image generation requires a user-confirmed media execution ticket.');
        },
    }));
}

/**
 * Wrap the official Pi 1.0.0 createCodemodeExtension(options) factory (or its
 * built-in factory) before loading it in main or child native extensions.
 * Pass options to the official factory unchanged, then wrap its returned factory:
 *   factory: wrapCodemodeExtension(createCodemodeExtension(options))
 *
 * Only codemode execute's model registry is narrowed. Schema reference identity,
 * loadout preparation, discovery, nested tool permission checks, store and usage
 * remain official. Each execution uses its current registry, including after
 * session/resource reload; neither the original context nor runtime is mutated.
 */
export function wrapCodemodeExtension(factory) {
    return pi => factory(new Proxy(pi, {
        get(target, key) {
            if (key === 'registerTool') return tool => {
                if (tool.name !== 'codemode') return target.registerTool(tool);
                return target.registerTool({
                    ...tool,
                    execute(toolCallId, params, signal, onUpdate, ctx) {
                        const registry = ctx && codemodeModelRegistry(ctx.modelRegistry);
                        const context = ctx && new Proxy(ctx, {
                            get(original, property) {
                                return property === 'modelRegistry' ? registry : Reflect.get(original, property);
                            },
                        });
                        return tool.execute(toolCallId, params, signal, onUpdate, context);
                    },
                });
            };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }));
}
