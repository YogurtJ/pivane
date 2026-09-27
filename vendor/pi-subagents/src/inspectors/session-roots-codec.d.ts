/**
 * Windows PowerShell has no backslash-escape for embedded double quotes: a
 * double-quoted string literal only recognizes `` `" `` or `""` to embed a
 * literal quote, so a naively-quoted JSON array (which is full of `"` and
 * `\` characters) gets truncated or split into multiple argv tokens the
 * moment PowerShell tokenizes the `pane run` command line.
 *
 * Base64 has no quotes, backslashes, or spaces for any shell to mangle, so
 * encoding the `--session-roots` payload sidesteps quoting entirely. It is
 * also plain ASCII, so it never hits shellQuote's Windows quoting branch in
 * a way that could still fail as new characters are added upstream.
 */
export declare function encodeSessionRoots(roots: readonly string[]): string;
/** Decodes a `--session-roots` argument produced by {@link encodeSessionRoots}. */
export declare function decodeSessionRoots(raw: string): string[];
//# sourceMappingURL=session-roots-codec.d.ts.map