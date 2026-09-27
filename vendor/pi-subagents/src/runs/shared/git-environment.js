const GIT_ROUTING_VARIABLES = new Set([
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_GRAFT_FILE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_WORK_TREE",
]);
function isGitRoutingVariable(name) {
    // Windows environment names are case-insensitive, and Git for Windows reads them that way.
    const upper = name.toUpperCase();
    return GIT_ROUTING_VARIABLES.has(upper) || /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(upper);
}
/** Remove inherited values that can route Git commands away from the child cwd. */
export function omitGitRoutingEnv(env) {
    return Object.fromEntries(Object.entries(env).filter(([name]) => !isGitRoutingVariable(name)));
}
//# sourceMappingURL=git-environment.js.map