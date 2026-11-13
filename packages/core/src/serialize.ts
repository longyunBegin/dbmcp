export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `<buffer ${value.length} bytes>`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = toJsonSafe(item);
  }
  return out;
}

export interface RowsPayload {
  rows?: unknown[];
  [key: string]: unknown;
}

/**
 * Serialize a tool payload while respecting a hard byte ceiling. Table data is
 * what blows up agent context, so rows are dropped from the tail first.
 */
export function stringifyCapped(payload: unknown, maxBytes: number): string {
  const safe = toJsonSafe(payload);
  const full = JSON.stringify(safe, null, 2);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  const record = safe as RowsPayload;
  if (record && Array.isArray(record.rows) && record.rows.length > 0) {
    let low = 0;
    let high = record.rows.length;
    let best = '';
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = JSON.stringify(
        {
          ...record,
          rows: record.rows.slice(0, mid),
          truncated: true,
          notice: `结果超过 ${maxBytes} 字节上限，已截断为前 ${mid} 行；请缩小查询范围或加 LIMIT。`,
        },
        null,
        2,
      );
      if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
        best = candidate;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (best) return best;
  }

  const note = `\n...(结果超过 ${maxBytes} 字节上限，已截断)`;
  const budget = Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8'));
  return `${Buffer.from(full, 'utf8').subarray(0, budget).toString('utf8')}${note}`;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
