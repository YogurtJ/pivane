export function backgroundProcessOptions(platform = process.platform) {
    return {
        detached: platform !== "win32",
        windowsHide: true,
    };
}
