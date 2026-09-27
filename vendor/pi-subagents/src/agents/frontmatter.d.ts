/**
 * Normalize a simple-scalar frontmatter list from comma-separated or block-list syntax.
 * Only the standard `- item` marker is removed; ordinary hyphenated values stay intact.
 */
export declare function parseFrontmatterList(raw: string | undefined): string[] | undefined;
/**
 * Parse YAML frontmatter from agent/chain files.
 * Handles both flat (key: value) and nested block (key: \n  sub: val) values.
 * Block values are stored as single strings with embedded newlines.
 * The indentation of the block content is preserved relative to the key.
 */
export declare function parseFrontmatter(content: string): {
    frontmatter: Record<string, string>;
    body: string;
};
//# sourceMappingURL=frontmatter.d.ts.map