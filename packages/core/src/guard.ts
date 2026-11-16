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
const VAR_ASSIGN = /:=/;

/**
 * 代码级硬规则：任何配置都无法放行这四类之外的语句。
 * 配置只能在此基础上继续收紧，不能放宽。
 */
export const HARD_ALLOWED_SQL_VERBS = ['select', 'show', 'describe', 'explain'];

/**
 * Redis 硬拒绝命令：即使配置把它们写进 allow 也不会执行。
 */
export const HARD_DENIED_REDIS_COMMANDS = new Set([
  'set', 'setnx', 'setex', 'psetex', 'mset', 'msetnx', 'append', 'setrange', 'incr', 'decr',
  'incrby', 'decrby', 'incrbyfloat', 'getset', 'getdel', 'getex',
  'del', 'unlink', 'rename', 'renamenx', 'move', 'copy', 'restore', 'dump',
  'hset', 'hsetnx', 'hmset', 'hdel', 'hincrby', 'hincrbyfloat',
  'lpush', 'rpush', 'lpop', 'rpop', 'lset', 'linsert', 'lrem', 'ltrim', 'rpoplpush', 'lmove',
  'sadd', 'srem', 'spop', 'smove', 'sinterstore', 'sunionstore', 'sdiffstore',
  'zadd', 'zincrby', 'zrem', 'zremrangebyrank', 'zremrangebyscore', 'zunionstore', 'zinterstore',
  'expire', 'pexpire', 'expireat', 'pexpireat', 'persist', 'touch',
  'flushall', 'flushdb', 'swapdb', 'select',
  'eval', 'evalsha', 'eval_ro', 'evalsha_ro', 'function', 'fcall', 'fcall_ro', 'script',
  'config', 'debug', 'module', 'client', 'monitor', 'shutdown', 'slaveof', 'replicaof',
  'migrate', 'cluster', 'acl', 'latency', 'memory', 'save', 'bgsave', 'bgrewriteaof',
  'keys', 'randomkey',
]);

/** 取配置与硬规则的并集，保证永远只有读能力。 */
function normalizeAllow(allow: string[]): string[] {
  const narrowed = (allow || [])
    .map((verb) => verb.toLowerCase())
    .filter((verb) => HARD_ALLOWED_SQL_VERBS.includes(verb));
  return narrowed.length > 0 ? narrowed : [...HARD_ALLOWED_SQL_VERBS];
}

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

  const allowed = normalizeAllow(allow);

  const single = text.replace(/;+\s*$/, '');
  if (single.includes(';')) {
    return { ok: false, reason: '不允许一次执行多条语句' };
  }
  if (VAR_ASSIGN.test(single)) {
    return { ok: false, reason: '禁止在查询中赋值变量（:=）' };
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
    if (!allowed.includes(verb) && !allowed.includes(raw)) {
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
  if (verb !== 'select' || !allowed.includes(verb)) {
    return {
      ok: false,
      verb,
      reason: `根动词 ${verb ? verb.toUpperCase() : '未知'} 不在白名单（只允许: ${allowed.join('/')}）`,
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

/** Redis command gate: hard deny list first, then explicit allow list. */
export function guardRedisCommand(command: string, allow: string[], deny: string[]): GuardResult {
  const verb = command.trim().toLowerCase();
  if (!verb) return { ok: false, reason: '空命令' };
  if (HARD_DENIED_REDIS_COMMANDS.has(verb)) {
    return { ok: false, verb, reason: `命令 ${verb.toUpperCase()} 属于写操作或危险命令，任何配置都不允许执行` };
  }
  if (deny.includes(verb)) return { ok: false, verb, reason: `命令 ${verb.toUpperCase()} 被显式禁止` };
  if (!allow.includes(verb)) {
    return { ok: false, verb, reason: `命令 ${verb.toUpperCase()} 不在白名单（允许: ${allow.join('/')}）` };
  }
  return { ok: true, verb };
}
