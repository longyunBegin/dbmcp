/** Column / key redaction helpers. Patterns use `*` or `table.column` form. */
export function matchPattern(pattern: string, candidate: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedCandidate = candidate.trim().toLowerCase();
  if (!normalizedPattern) return false;

  const patternColumn = normalizedPattern.includes('.')
    ? normalizedPattern.slice(normalizedPattern.lastIndexOf('.') + 1)
    : normalizedPattern;
  const candidateColumn = normalizedCandidate.includes('.')
    ? normalizedCandidate.slice(normalizedCandidate.lastIndexOf('.') + 1)
    : normalizedCandidate;

  if (patternColumn === '*') return true;
  return patternColumn === candidateColumn;
}

export function isColumnRedacted(column: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchPattern(pattern, column));
}

export function redactRows(
  rows: Record<string, unknown>[],
  columns: string[],
  patterns: string[],
): { rows: Record<string, unknown>[]; redacted: string[] } {
  const hit = columns.filter((column) => isColumnRedacted(column, patterns));
  if (hit.length === 0) return { rows, redacted: [] };
  const masked = rows.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const column of hit) {
      if (column in next) next[column] = '***REDACTED***';
    }
    return next;
  });
  return { rows: masked, redacted: hit };
}
