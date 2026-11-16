import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

const LimitsSchema = z
  .object({
    maxRows: z.number().int().positive().default(200),
    maxBytes: z.number().int().positive().default(262_144),
    timeoutMs: z.number().int().positive().default(5_000),
    maxConcurrent: z.number().int().positive().default(2),
  })
  .default({});

const MysqlPolicySchema = z
  .object({
    allow: z.array(z.string()).default(['select', 'show', 'describe', 'explain']),
    denyFunctions: z
      .array(z.string())
      .default(['load_file', 'get_lock', 'release_lock', 'sleep', 'benchmark', 'sys_exec', 'sys_eval']),
  })
  .default({});

const RedisPolicySchema = z
  .object({
    allow: z
      .array(z.string())
      .default([
        'get',
        'mget',
        'hget',
        'hgetall',
        'hmget',
        'lrange',
        'smembers',
        'sscan',
        'zrange',
        'hscan',
        'scan',
        'type',
        'ttl',
        'pttl',
        'exists',
        'dbsize',
        'strlen',
        'strtype',
        'llen',
        'scard',
        'zcard',
        'info',
        'ping',
      ]),
    deny: z
      .array(z.string())
      .default([
        'eval',
        'evalsha',
        'eval_ro',
        'evalsha_ro',
        'function',
        'fcall',
        'script',
        'config',
        'debug',
        'module',
        'client',
        'monitor',
        'flushall',
        'flushdb',
        'migrate',
        'restore',
        'replicaof',
        'slaveof',
        'cluster',
        'swapdb',
        'set',
        'del',
        'rename',
        'hset',
        'lpush',
        'sadd',
        'zadd',
        'expire',
        'persist',
        'keys',
        'randomkey',
      ]),
  })
  .default({});

export const PolicySchema = z
  .object({
    mysql: MysqlPolicySchema,
    redis: RedisPolicySchema,
    limits: LimitsSchema,
    redact: z
      .object({
        mysqlColumns: z.array(z.string()).default([]),
        redisKeyPatterns: z.array(z.string()).default([]),
      })
      .default({}),
  })
  .default({});

const ConnectionSchema = z.object({
  engine: z.enum(['mysql', 'redis']),
  host: z.string().optional(),
  port: z.number().int().positive().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  url: z.string().optional(),
  secretRef: z.string().optional(),
  password: z.string().optional(),
  passwordEnv: z.string().optional(),
  envFile: z.array(z.string()).default([]),
  ssl: z.union([z.boolean(), z.record(z.unknown())]).default(false),
  schemas: z.array(z.string()).default([]),
  keyPrefixes: z.array(z.string()).default([]),
  production: z.boolean().default(false),
  /** 环境标识：dev / test / uat / prod，仅用于展示与提示 */
  environment: z.string().optional(),
  policy: z.string().optional(),
  readonlySession: z.boolean().default(true),
  allowPlaintext: z.boolean().default(false),
});

export const ProjectConfigSchema = z.object({
  version: z.number().int().default(1),
  binding: z
    .object({
      gitRemote: z.string().optional(),
      path: z.string().optional(),
    })
    .default({}),
  defaultPolicy: z.string().default('read'),
  policies: z.record(PolicySchema).default({}),
  connections: z.record(ConnectionSchema),
});

export type Limits = z.infer<typeof LimitsSchema>;
export type Policy = z.infer<typeof PolicySchema>;
export type ConnectionConfig = z.infer<typeof ConnectionSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

export interface ResolvedConnection {
  name: string;
  engine: 'mysql' | 'redis';
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  url?: string;
  ssl: boolean | Record<string, unknown>;
  schemas: string[];
  keyPrefixes: string[];
  production: boolean;
  environment?: string;
  readonlySession: boolean;
  policyName: string;
  policy: Policy;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export function interpolateEnv(value: string, env: NodeJS.ProcessEnv = process.env): string {
  return value.replace(PLACEHOLDER, (whole, name: string, fallback?: string) => {
    const resolved = env[name];
    if (resolved !== undefined) return resolved;
    return fallback !== undefined ? fallback : whole;
  });
}

function deepInterpolate(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((item) => deepInterpolate(item, env));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = deepInterpolate(item, env);
    }
    return out;
  }
  return value;
}

function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}

function validateConnections(config: ProjectConfig): void {
  for (const [name, conn] of Object.entries(config.connections)) {
    if (conn.url && /^[a-z+]+:\/\/[^/@\s]+:[^/@\s]*@/i.test(conn.url)) {
      throw new Error(
        `连接 "${name}" 的 url 中包含密码。请移除 url 里的密码，改用 secretRef 或 passwordEnv。`,
      );
    }
    if (conn.engine === 'mysql' && !conn.url && !conn.host) {
      throw new Error(`连接 "${name}" 缺少 host 或 url`);
    }
    if (conn.engine === 'redis' && !conn.url && !conn.host) {
      throw new Error(`连接 "${name}" 缺少 host 或 url`);
    }
  }
}

export interface LoadedProjectConfig {
  config: ProjectConfig;
  file: string;
  dir: string;
}

export function loadProjectConfig(file: string, env: NodeJS.ProcessEnv = process.env): LoadedProjectConfig {
  if (!fs.existsSync(file)) {
    throw new Error(`配置文件不存在: ${file}`);
  }
  const raw = YAML.parse(fs.readFileSync(file, 'utf8'));
  const parsed = ProjectConfigSchema.safeParse(deepInterpolate(raw, env));
  if (!parsed.success) {
    throw new Error(`配置校验失败 (${file}):\n${formatIssues(parsed.error)}`);
  }
  validateConnections(parsed.data);
  return { config: parsed.data, file, dir: path.dirname(file) };
}

export function resolvePolicy(config: ProjectConfig, conn: ConnectionConfig): Policy {
  const name = conn.policy || config.defaultPolicy;
  const policy = config.policies[name] ?? (name === 'read' ? DEFAULT_POLICY : undefined);
  if (!policy) throw new Error(`连接引用的策略 "${name}" 不存在`);
  return policy;
}

export function resolveConnection(
  config: ProjectConfig,
  name?: string,
): { name: string; conn: ConnectionConfig } {
  const names = Object.keys(config.connections);
  if (names.length === 0) throw new Error('配置中没有任何连接');
  if (!name) {
    if (names.length > 1) {
      throw new Error(`存在多个连接，请指定 connection 参数（可选: ${names.join(', ')}）`);
    }
    name = names[0];
  }
  const conn = config.connections[name!];
  if (!conn) throw new Error(`连接 "${name}" 不存在（可选: ${names.join(', ')}）`);
  return { name: name!, conn };
}

export function toResolvedConnection(
  name: string,
  conn: ConnectionConfig,
  policy: Policy,
): ResolvedConnection {
  return {
    name,
    engine: conn.engine,
    host: conn.host,
    port: conn.port,
    database: conn.database,
    user: conn.user,
    url: conn.url,
    ssl: conn.ssl,
    schemas: conn.schemas,
    keyPrefixes: conn.keyPrefixes,
    production: conn.production,
    environment: conn.environment,
    readonlySession: conn.readonlySession,
    policyName: conn.policy || 'read',
    policy,
  };
}
