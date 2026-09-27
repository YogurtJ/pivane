/**
 * Keep opaque index keys below common filesystem component limits.
 *
 * Portable short values retain the historical URI-encoded representation.
 * Oversized or non-portable values use a deterministic digest so callers can
 * resolve the same index without persisting a separate lookup table.
 *
 * Encoded backslashes and trailing file extensions are not portable. Pi session
 * ids are often the full session `.jsonl` path. On Windows, `readdir` of a
 * directory whose name ends in `.jsonl` or contains `%5C` can fail with EPERM.
 */
export declare const MAX_INDEX_SEGMENT_BYTES = 255;
export declare function encodeIndexSegment(value: string, maxBytes?: number): string;
/** Current write key first, then the pre-hash URI-encoded key when it still fits. */
export declare function indexSegmentAliases(value: string, maxBytes?: number): string[];
//# sourceMappingURL=index-segment.d.ts.map