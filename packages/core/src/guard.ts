import { Parser } from 'node-sql-parser';

export interface GuardResult {
  ok: boolean;
  verb?: string;
  reason?: string;
}

const SIMPLE_READ = /^(show|desc|describe|explain)\b/i;
const EXPLAIN_ANALYZE = /\bexplain\s+(analyze|analyse)\b/i;
const INTO_FILE = /\binto\s+(outfile|dumpfile)\b/i;
const LOCKING_READ = /\b(for\s+update|for\s+share|lock\s+in\s+share\s+mode)\b/i;

const parser = new Parser();

function collectFunctions(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) collectFunctions(item, out);
    return;
  }
  const record = node as Record<string, unknown>;
  const type = record.type;
  if (type === 'function' || type === 'aggr_func') {
    const name = record.name;
    if (typeof name === 'string') {
      out.add(name.toLowerCase());
    } else if (name && typeof name === 'object') {
      const parts = (name as { name?: unknown }).name;
      if (Array.isArray(parts)) {
        const joined = parts
          .map((part) => (typeof part === 'string' ? part : (part as { value?: string })?.value))
          .filter(Boolean)
          .join('.');
        if (joined) out.add(joined.toLowerCase());
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'loc') continue;
    collectFunctions(value, out);
  }
}

/**
 * Conservative read-only gate. Fails closed: an unparseable statement is rejected.
 */
export function guardSql(sql: string, allow: string[], denyFunctions: string[]): GuardResult {
  const text = sql.trim();
  if (!text) return { ok: false, reason: '空语句' };

  const single = text.replace(/;+\s*$/, '');
  if (single.includes(';')) {
    return { ok: false, reason: '不允许一次执行多条语句' };
  }
  if (EXPLAIN_ANALYZE.test(single)) {
    return { ok: false, reason: 'EXPLAIN ANALYZE 会真实执行语句，已禁用' };
  }
  if (INTO_FILE.test(single)) {
    return { ok: false, reason: '禁止 INTO OUTFILE / DUMPFILE' };
  }
  if (LOCKING_READ.test(single)) {
    return { ok: false, reason: '禁止 FOR UPDATE / LOCK IN SHARE MODE' };
  }

  if (SIMPLE_READ.test(single)) {
    const raw = single.split(/\s+/)[0].toLowerCase();
    const verb = raw === 'desc' ? 'describe' : raw;
    if (!allow.includes(verb) && !allow.includes(raw)) {
      return { ok: false, verb, reason: `语句类型 ${raw.toUpperCase()} 不在白名单` };
    }
    return { ok: true, verb };
  }

  let ast: unknown;
  try {
    ast = parser.astify(single, { database: 'MySQL' });
  } catch (error) {
    return {
      ok: false,
      reason: `无法解析语句，已按失败关闭处理: ${(error as Error).message.split('\n')[0]}`,
    };
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) {
    return { ok: false, reason: '只允许单条语句' };
  }

  const node = statements[0] as Record<string, unknown> | null;
  const verb = String(node?.type || '').toLowerCase();
  if (verb !== 'select' || !allow.includes(verb)) {
    return {
      ok: false,
      verb,
      reason: `根动词 ${verb ? verb.toUpperCase() : '未知'} 不在白名单（允许: ${allow.join('/')}）`,
    };
  }
  if (node?.locking) {
    return { ok: false, verb, reason: '禁止 FOR UPDATE / LOCK IN SHARE MODE' };
  }
  if (node?.into && (node.into as { type?: string }).type === 'into') {
    return { ok: false, verb, reason: '禁止 SELECT ... INTO' };
  }

  const functions = new Set<string>();
  collectFunctions(node, functions);
  const blocked = [...functions].filter((name) => denyFunctions.includes(name));
  if (blocked.length > 0) {
    return { ok: false, verb, reason: `禁止调用函数: ${blocked.join(', ')}` };
  }

  return { ok: true, verb };
}

/** Redis command gate: explicit allow list, everything else denied. */
export function guardRedisCommand(command: string, allow: string[], deny: string[]): GuardResult {
  const verb = command.trim().toLowerCase();
  if (!verb) return { ok: false, reason: '空命令' };
  if (deny.includes(verb)) return { ok: false, verb, reason: `命令 ${verb.toUpperCase()} 被显式禁止` };
  if (!allow.includes(verb)) {
    return { ok: false, verb, reason: `命令 ${verb.toUpperCase()} 不在白名单（允许: ${allow.join('/')}）` };
  }
  return { ok: true, verb };
}
