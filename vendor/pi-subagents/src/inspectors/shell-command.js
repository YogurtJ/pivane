function shellQuote(value, platform) {
    if (platform === "win32")
        return `"${value.replaceAll('"', '\\"')}"`;
    return `'${value.replaceAll("'", "'\\''")}'`;
}
function isBareExecutable(value) {
    return /^[\w./@:-]+$/.test(value);
}
export function formatShellCommand(exe, args, platform = process.platform) {
    const quotedArgs = args.map((arg) => shellQuote(arg, platform));
    if (platform === "win32")
        return `& ${[shellQuote(exe, platform), ...quotedArgs].join(" ")}`;
    // Nushell treats a leading quoted token as a string, so use a bare invoker for paths that need quoting.
    const invocation = isBareExecutable(exe) ? exe : `sh -c 'exec "$0" "$@"' ${shellQuote(exe, platform)}`;
    return [invocation, ...quotedArgs].join(" ");
}
//# sourceMappingURL=shell-command.js.map