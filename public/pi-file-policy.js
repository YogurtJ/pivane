((root, factory) => {
    const policy = factory();
    if (typeof module === 'object' && module.exports) module.exports = policy;
    else root.PiFilePolicy = policy;
})(typeof window === 'object' ? window : globalThis, () => {
    const privateDirs = new Set(['.pi', '.ssh', '.aws', '.azure', '.gnupg', '.config', '.git', 'backups', '.web-backups']);
    function restricted(value) {
        return String(value).replace(/\\/g, '/').split('/').some(part => {
            part = part.toLowerCase();
            return privateDirs.has(part) || /^\.env(?:\.|$)/.test(part)
                || /^(?:auth|pi5-access|pi5-notifications|models|models-store|credentials|connections)\.json(?:$|[.~_-])/.test(part)
                || /^(?:\.npmrc|\.netrc|\.pypirc|id_rsa|id_ed25519|id_ecdsa)(?:$|[.~_-])/.test(part)
                || /\.(?:pem|key|p12|pfx|kdbx)(?:$|[.~_-])/.test(part);
        });
    }
    return { restricted, maxBytes: 2 * 1024 * 1024 };
});
