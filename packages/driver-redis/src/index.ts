import type { LiveConnection } from '@dbmcp/core';
import Redis from 'ioredis';

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export class RedisSession {
  private readonly patterns: RegExp[];

  private constructor(
    private readonly client: Redis,
    private readonly keyPrefixes: string[],
    private readonly timeoutMs: number,
  ) {
    this.patterns = keyPrefixes.filter(Boolean).map(globToRegExp);
  }

  static async open(target: LiveConnection): Promise<RedisSession> {
    const options = {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 8000,
      commandTimeout: target.policy.limits.timeoutMs,
      ...(target.ssl && target.ssl !== true ? { tls: target.ssl as Record<string, unknown> } : {}),
      ...(target.ssl === true ? { tls: {} } : {}),
    };

    const client = target.url
      ? new Redis(target.url, options)
      : new Redis({
          host: target.host,
          port: target.port ?? 6379,
          password: target.password,
          ...options,
        });

    client.on('error', () => {
      // surfaced through the awaited command instead of crashing the process
    });

    await client.connect();
    return new RedisSession(client, target.keyPrefixes, target.policy.limits.timeoutMs);
  }

  private assertKeyAllowed(key: string): void {
    if (this.patterns.length === 0) return;
    if (!this.patterns.some((pattern) => pattern.test(key))) {
      throw new Error(
        `key "${key}" 不在允许的前缀范围 (${this.keyPrefixes.join(', ')})，已拒绝访问`,
      );
    }
  }

  async scan(pattern: string, cursor: string, limit: number): Promise<{
    cursor: string;
    keys: string[];
    truncated: boolean;
  }> {
    const [next, keys] = await this.client.scan(cursor || '0', 'MATCH', pattern, 'COUNT', limit);
    const allowed = keys.filter((key) => this.patterns.length === 0 || this.patterns.some((p) => p.test(key)));
    return { cursor: String(next), keys: allowed, truncated: String(next) !== '0' };
  }

  async inspect(key: string, limit: number): Promise<Record<string, unknown>> {
    this.assertKeyAllowed(key);
    const type = await this.client.type(key);
    const ttl = await this.client.ttl(key);
    const base = { key, type, ttl };

    if (type === 'none') return { ...base, exists: false };

    switch (type) {
      case 'string': {
        const value = await this.client.get(key);
        const size = await this.client.strlen(key);
        return { ...base, bytes: size, value: truncate(value ?? '', limit) };
      }
      case 'hash': {
        const [next, flat] = await this.client.hscan(key, '0', 'COUNT', limit);
        const fields: Record<string, string> = {};
        for (let i = 0; i < flat.length; i += 2) {
          fields[flat[i]] = flat[i + 1];
        }
        return { ...base, total: await this.client.hlen(key), fields, truncated: String(next) !== '0' };
      }
      case 'list': {
        const [total, items] = await Promise.all([
          this.client.llen(key),
          this.client.lrange(key, 0, limit - 1),
        ]);
        return { ...base, total, items, truncated: total > limit };
      }
      case 'set': {
        const [total, [next, members]] = await Promise.all([
          this.client.scard(key),
          this.client.sscan(key, '0', 'COUNT', limit),
        ]);
        return { ...base, total, members, truncated: String(next) !== '0' };
      }
      case 'zset': {
        const [total, pairs] = await Promise.all([
          this.client.zcard(key),
          this.client.zrange(key, 0, limit - 1, 'WITHSCORES'),
        ]);
        const members: { member: string; score: string }[] = [];
        for (let i = 0; i < pairs.length; i += 2) {
          members.push({ member: pairs[i], score: pairs[i + 1] });
        }
        return { ...base, total, members, truncated: total > limit };
      }
      case 'stream': {
        const [total, entries] = await Promise.all([
          this.client.xlen(key),
          this.client.xrange(key, '-', '+', 'COUNT', limit),
        ]);
        return { ...base, total, entries, truncated: total > limit };
      }
      default:
        return { ...base, notice: `暂不支持的 key 类型: ${type}` };
    }
  }

  async info(): Promise<Record<string, unknown>> {
    const [dbsize, raw] = await Promise.all([this.client.dbsize(), this.client.info('server')]);
    const parsed: Record<string, string> = {};
    for (const line of String(raw).split(/\r?\n/)) {
      const match = /^([a-z_]+):(.+)$/.exec(line.trim());
      if (match) parsed[match[1]] = match[2];
    }
    return {
      dbsize,
      redisVersion: parsed.redis_version ?? 'unknown',
      os: parsed.os ?? 'unknown',
      uptimeSeconds: parsed.uptime_in_seconds ?? 'unknown',
    };
  }

  /** Raw command used by `dbmcp doctor` permission probes. Bypasses the command allow list on purpose. */
  async raw(command: string, ...args: Array<string | number>): Promise<unknown> {
    return this.client.call(command, ...(args.map(String) as [string, ...string[]]));
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}…(已截断，共 ${value.length} 字符)`;
}
