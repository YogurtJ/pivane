/**
 * Pi's extension loader supplies the embedded SDK. Bare Bun/Node cannot replace
 * it: an apparent import success can be an auto-installed, different SDK.
 * Await the configured runner inside extension initialization so the outer Pi
 * session/RPC loop never starts. Exit only after shared disposal/lease release.
 * Derived from xz-dev's PR #2049, commit 910807bfefcf9ee41d73fa25ec86dcd75ab8f4b2.
 */
export default function runBinaryBootstrap(): Promise<never>;
//# sourceMappingURL=binary-bootstrap.d.ts.map