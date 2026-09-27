export function normalizeMemoryLookupText(text: string): string {
  let normalized = text.trim();
  if (!normalized) return "";

  const firstNonEmptyLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstNonEmptyLine) normalized = firstNonEmptyLine;

  // Current memory_search results use a URL-encoded scope token so arbitrary
  // project names cannot terminate the prefix early.
  normalized = normalized.replace(
    /^\S+\s+scope=(?:global|project:[^\s]+)\s+\[target=(?:memory|user|project|failure)\]\s+/u,
    "",
  );
  normalized = normalized.replace(/^\S+\s+\[[^\]]+\]\s+/u, "");
  // memory_search labels each result with its mutation target after the scope.
  // Keep copied search lines usable as replace/remove lookup text.
  normalized = normalized.replace(/^\[target=(?:memory|user|project|failure)\]\s+/u, "");
  normalized = normalized.replace(/^(\[[^\]]+\])\s+\1(\s+|$)/, "$1 ");

  return normalized.trim();
}
