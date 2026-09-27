export function shouldUseNativeFsWatch(_purpose, platform = process.platform) {
    if (_purpose === "retained-nested-route-tracker" && platform === "win32")
        return false;
    return platform !== "darwin";
}
//# sourceMappingURL=watch-strategy.js.map