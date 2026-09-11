// Keep signal listeners registered while asynchronous disposal is pending.
// Removing a once-listener early lets signal-exit re-send the signal mid-cleanup.
function registerProcessShutdown(dispose) {
    let pending;
    function shutdown() {
        if (!pending) {
            pending = Promise.resolve().then(dispose).then(() => process.exit(0), error => {
                console.error('Pivane shutdown failed:', error?.message || String(error));
                process.exit(1);
            });
        }
        return pending;
    }
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return shutdown;
}
module.exports = { registerProcessShutdown };
