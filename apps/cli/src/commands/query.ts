import {
  guardSql,
  openConnection,
  openProject,
  redactRows,
  stringifyCapped,
} from '@dbmcp/core';
import { MysqlSession } from '@dbmcp/driver-mysql';

export interface QueryOptions {
  dir?: string;
  connection?: string;
  maxRows?: string;
  allowProd?: boolean;
}

export async function queryCommand(sql: string, options: QueryOptions): Promise<void> {
  const project = openProject(options.dir || process.cwd());
  if (!project) throw new Error('当前目录未绑定 dbmcp，先运行 dbmcp init');

  const { connection, secret } = openConnection(project, options.connection);

  if (connection.engine !== 'mysql') {
    throw new Error(`连接 "${connection.name}" 不是 MySQL，Redis 请用 MCP 的 redis_* 工具`);
  }
  if (connection.production && !options.allowProd) {
    throw new Error(`连接 "${connection.name}" 标记为生产库，需要 --allow-prod`);
  }
  if (!secret.password) {
    throw new Error(secret.warning || `缺少密码，执行 dbmcp secret set ${connection.name}`);
  }

  const policy = connection.policy;
  const guard = guardSql(sql, policy.mysql.allow, policy.mysql.denyFunctions);
  if (!guard.ok) throw new Error(guard.reason ?? '语句被拒绝');

  const requested = Number(options.maxRows ?? policy.limits.maxRows);
  const maxRows = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : policy.limits.maxRows,
    policy.limits.maxRows,
  );

  const session = await MysqlSession.open(connection);
  try {
    const result = await session.query(sql, maxRows);
    const { rows, redacted } = redactRows(
      result.rows as Record<string, unknown>[],
      result.columns,
      policy.redact.mysqlColumns,
    );
    console.log(
      stringifyCapped(
        {
          connection: connection.name,
          verb: guard.verb,
          columns: result.columns,
          rowCount: result.rowCount,
          returned: rows.length,
          truncated: result.truncated,
          redactedColumns: redacted,
          rows,
        },
        policy.limits.maxBytes,
      ),
    );
  } finally {
    await session.close();
  }
}
