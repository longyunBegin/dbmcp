import {
  LiveConnection,
  ProjectContext,
  guardSql,
  openConnection,
  openProject,
  redactRows,
  resolveConnection,
  resolvePassword,
  resolvePolicy,
  stringifyCapped,
} from '@dbmcp/core';
import { MysqlSession } from '@dbmcp/driver-mysql';
import { RedisSession } from '@dbmcp/driver-redis';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export interface ServerOptions {
  startDir?: string;
  allowProd?: boolean;
  version?: string;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Thrown for expected, user-actionable rejections. */
class ToolError extends Error {}

const TOOLS: ToolDefinition[] = [
  {
    name: 'db_list_connections',
    description:
      '列出当前项目已绑定的数据库连接（只读）。返回连接名、引擎、库名、策略、是否生产库。首次使用请先调用它确认可用连接。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'db_list_tables',
    description:
      '列出 MySQL 表名（只读，最多 500 条）。结果可能被截断，请优先使用 pattern 过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名，省略时自动选择唯一的连接' },
        schema: { type: 'string', description: '库名，省略时使用连接默认库' },
        pattern: { type: 'string', description: '表名 LIKE 模式，例如 order_%' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'db_describe_table',
    description: '查看 MySQL 表结构：列、类型、索引、外键、注释（只读，敏感列默认值会被脱敏）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string', description: '表名' },
        schema: { type: 'string', description: '库名，省略时使用连接默认库' },
      },
      required: ['table'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_search_columns',
    description: '按列名或注释关键字反查表，是了解陌生 schema 最省 token 的入口（只读）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        keyword: { type: 'string', description: '列名或注释关键字' },
        schema: { type: 'string', description: '库名，省略时使用连接默认库' },
      },
      required: ['keyword'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_query',
    description:
      '执行只读 SQL：仅允许 SELECT / SHOW / DESCRIBE / EXPLAIN。多语句、写操作、FOR UPDATE、INTO OUTFILE 会被拒绝。结果超过上限会被截断。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string', description: '单条只读 SQL' },
        maxRows: { type: 'number', description: '返回行数上限，不得超过策略上限' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'db_explain',
    description: '对一条只读 SQL 执行 EXPLAIN（不会真正执行被分析的语句）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        sql: { type: 'string', description: '要分析的 SELECT 语句' },
      },
      required: ['sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'redis_scan',
    description: '用 SCAN 遍历 Redis key（只读，永不使用 KEYS）。受 key 前缀白名单限制。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        pattern: { type: 'string', description: '匹配模式，例如 app:order:*' },
        cursor: { type: 'string', description: '游标，首次传 0' },
        limit: { type: 'number', description: '单次返回上限' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
  },
  {
    name: 'redis_inspect',
    description: '查看一个 Redis key 的结构：类型、TTL、按类型返回部分内容（只读，自动限长）。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        key: { type: 'string', description: 'key 名' },
        limit: { type: 'number', description: '返回元素上限' },
      },
      required: ['key'],
      additionalProperties: false,
    },
  },
  {
    name: 'redis_info',
    description: '返回 Redis 基本信息：dbsize、版本、运行时长（只读）。',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      additionalProperties: false,
    },
  },
];

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.queue.shift()?.();
    }
  }
}

type AnySession = MysqlSession | RedisSession;

interface SessionEntry {
  session: AnySession;
  connection: LiveConnection;
  semaphore: Semaphore;
}

export async function startServer(options: ServerOptions = {}): Promise<void> {
  const startDir = options.startDir || process.cwd();
  const allowProd = options.allowProd === true;
  const project: ProjectContext | undefined = safeOpenProject(startDir);
  const sessions = new Map<string, SessionEntry>();

  function requireProject(): ProjectContext {
    if (!project) {
      throw new ToolError(
        '当前目录未绑定 dbmcp。请在该项目根目录执行: dbmcp init（项目内不会写入任何文件）',
      );
    }
    return project;
  }

  async function getSession(
    name: string | undefined,
    engine: 'mysql' | 'redis',
  ): Promise<SessionEntry> {
    const ctx = requireProject();
    const { connection, secret } = openConnection(ctx, name);

    if (connection.engine !== engine) {
      throw new ToolError(`连接 "${connection.name}" 的引擎是 ${connection.engine}，不是 ${engine}`);
    }
    if (connection.production && !allowProd) {
      throw new ToolError(
        `连接 "${connection.name}" 标记为生产库，默认拒绝访问。启动时加 --allow-prod 才能放行。`,
      );
    }
    if (!secret.password && connection.engine === 'mysql') {
      throw new ToolError(
        `连接 "${connection.name}" 缺少密码。${
          secret.warning ?? `请执行: dbmcp secret set ${connection.name}`
        }`,
      );
    }

    const key = `${engine}:${connection.name}`;
    const existing = sessions.get(key);
    if (existing) return existing;

    const session: AnySession =
      engine === 'mysql'
        ? await MysqlSession.open(connection)
        : await RedisSession.open(connection);

    const entry: SessionEntry = {
      session,
      connection,
      semaphore: new Semaphore(connection.policy.limits.maxConcurrent),
    };
    sessions.set(key, entry);
    return entry;
  }

  const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async db_list_connections() {
      const ctx = requireProject();
      const connections = Object.entries(ctx.config.connections).map(([name, conn]) => {
        const secret = resolvePassword(conn, {
          slug: ctx.binding.slug,
          projectRoot: ctx.root,
        });
        const target = conn.url
          ? conn.url.replace(/\/\/[^@/]*@/, '//')
          : `${conn.host ?? 'localhost'}${conn.port ? `:${conn.port}` : ''}`;
        return {
          name,
          engine: conn.engine,
          target,
          database: conn.database ?? null,
          schemaScope: conn.schemas.length > 0 ? conn.schemas : 'default',
          keyPrefixes: conn.keyPrefixes.length > 0 ? conn.keyPrefixes : null,
          policy: conn.policy || ctx.config.defaultPolicy,
          production: conn.production,
          available: Boolean(secret.password),
          secretSource: secret.source,
          warning: secret.warning ?? null,
        };
      });
      return {
        project: {
          slug: ctx.binding.slug,
          root: ctx.root,
          gitRemote: ctx.binding.gitRemote ?? null,
          boundBy: ctx.binding.source,
        },
        connections,
        note: '所有工具均为只读。写操作会被拒绝。',
      };
    },

    async db_list_tables(args) {
      const entry = await getSession(args.connection as string | undefined, 'mysql');
      const session = entry.session as MysqlSession;
      const tables = await entry.semaphore.run(() =>
        session.listTables(
          args.schema ? [String(args.schema)] : entry.connection.schemas,
          args.pattern ? String(args.pattern) : undefined,
        ),
      );
      return {
        connection: entry.connection.name,
        count: tables.length,
        truncated: tables.length >= 500,
        tables,
      };
    },

    async db_describe_table(args) {
      const entry = await getSession(args.connection as string | undefined, 'mysql');
      const session = entry.session as MysqlSession;
      const detail = await entry.semaphore.run(() =>
        session.describeTable(
          args.schema ? String(args.schema) : undefined,
          String(args.table),
        ),
      );
      const patterns = entry.connection.policy.redact.mysqlColumns;
      const columns = (detail.columns as Array<Record<string, unknown>>) || [];
      for (const column of columns) {
        if (matchesColumn(patterns, String(column.column ?? ''))) {
          column.default = '***REDACTED***';
        }
      }
      return { connection: entry.connection.name, ...detail };
    },

    async db_search_columns(args) {
      const entry = await getSession(args.connection as string | undefined, 'mysql');
      const session = entry.session as MysqlSession;
      const rows = await entry.semaphore.run(() =>
        session.searchColumns(
          String(args.keyword),
          args.schema ? [String(args.schema)] : entry.connection.schemas,
          100,
        ),
      );
      return {
        connection: entry.connection.name,
        keyword: args.keyword,
        count: rows.length,
        matches: rows,
      };
    },

    async db_query(args) {
      const entry = await getSession(args.connection as string | undefined, 'mysql');
      const session = entry.session as MysqlSession;
      const policy = entry.connection.policy;
      const sql = String(args.sql);

      const guard = guardSql(sql, policy.mysql.allow, policy.mysql.denyFunctions);
      if (!guard.ok) throw new ToolError(guard.reason ?? '语句被拒绝');

      const requested = Number(args.maxRows ?? policy.limits.maxRows);
      const maxRows = Math.min(
        Number.isFinite(requested) && requested > 0 ? requested : policy.limits.maxRows,
        policy.limits.maxRows,
      );

      const result = await entry.semaphore.run(() => session.query(sql, maxRows));
      const { rows, redacted } = redactRows(
        result.rows as Record<string, unknown>[],
        result.columns,
        policy.redact.mysqlColumns,
      );

      return {
        connection: entry.connection.name,
        verb: guard.verb,
        columns: result.columns,
        rowCount: result.rowCount,
        returned: rows.length,
        truncated: result.truncated,
        redactedColumns: redacted,
        rows,
      };
    },

    async db_explain(args) {
      const entry = await getSession(args.connection as string | undefined, 'mysql');
      const session = entry.session as MysqlSession;
      const policy = entry.connection.policy;
      const sql = String(args.sql);

      const guard = guardSql(sql, policy.mysql.allow, policy.mysql.denyFunctions);
      if (!guard.ok) throw new ToolError(guard.reason ?? '语句被拒绝');

      const result = await entry.semaphore.run(() =>
        session.query(`EXPLAIN ${sql}`, policy.limits.maxRows),
      );
      return {
        connection: entry.connection.name,
        plan: result.rows,
        rowCount: result.rowCount,
        truncated: result.truncated,
      };
    },

    async redis_scan(args) {
      const entry = await getSession(args.connection as string | undefined, 'redis');
      const session = entry.session as RedisSession;
      const limit = clampLimit(args.limit, entry.connection.policy.limits.maxRows);
      const result = await entry.semaphore.run(() =>
        session.scan(String(args.pattern), String(args.cursor ?? '0'), limit),
      );
      return { connection: entry.connection.name, ...result };
    },

    async redis_inspect(args) {
      const entry = await getSession(args.connection as string | undefined, 'redis');
      const session = entry.session as RedisSession;
      const limit = clampLimit(args.limit, entry.connection.policy.limits.maxRows);
      const result = await entry.semaphore.run(() => session.inspect(String(args.key), limit));
      return { connection: entry.connection.name, ...result };
    },

    async redis_info(args) {
      const entry = await getSession(args.connection as string | undefined, 'redis');
      const session = entry.session as RedisSession;
      const result = await entry.semaphore.run(() => session.info());
      return { connection: entry.connection.name, ...result };
    },
  };

  function maxBytesFor(args: Record<string, unknown>): number {
    if (!project) return 262_144;
    try {
      const { conn } = resolveConnection(project.config, args.connection as string | undefined);
      return resolvePolicy(project.config, conn).limits.maxBytes;
    } catch {
      return 262_144;
    }
  }

  const server = new Server(
    { name: 'dbmcp', version: options.version || '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = handlers[request.params.name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: `ERROR: 未知工具 ${request.params.name}` }],
        isError: true,
      };
    }

    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      const payload = await handler(args);
      return {
        content: [{ type: 'text', text: stringifyCapped(payload, maxBytesFor(args)) }],
      };
    } catch (error) {
      const message = error instanceof ToolError ? error.message : (error as Error).message;
      return {
        content: [{ type: 'text', text: `ERROR: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async (): Promise<void> => {
    for (const entry of sessions.values()) {
      await entry.session.close().catch(() => undefined);
    }
    sessions.clear();
  };

  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
}

function safeOpenProject(startDir: string): ProjectContext | undefined {
  try {
    return openProject(startDir);
  } catch {
    return undefined;
  }
}

function matchesColumn(patterns: string[], column: string): boolean {
  const target = column.toLowerCase();
  return patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    const leaf = normalized.includes('.')
      ? normalized.slice(normalized.lastIndexOf('.') + 1)
      : normalized;
    return leaf === '*' || leaf === target;
  });
}

function clampLimit(value: unknown, max: number): number {
  const parsed = Number(value ?? max);
  if (!Number.isFinite(parsed) || parsed <= 0) return max;
  return Math.min(parsed, max);
}
