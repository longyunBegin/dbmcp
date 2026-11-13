import type { LiveConnection } from '@dbmcp/core';
import mysql, { Connection, FieldPacket, RowDataPacket } from 'mysql2/promise';

export interface TableInfo {
  schema: string;
  table: string;
  type: string;
  estimatedRows: number | null;
  comment: string;
}

export interface ColumnInfo {
  column: string;
  type: string;
  nullable: boolean;
  key: string;
  default: unknown;
  extra: string;
  comment: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

const TABLE_LIMIT = 500;

export class MysqlSession {
  private constructor(
    private readonly connection: Connection,
    readonly serverVersion: string,
    readonly isMariaDb: boolean,
    readonly timeoutMs: number,
  ) {}

  static async open(target: LiveConnection): Promise<MysqlSession> {
    const connection = await mysql.createConnection({
      host: target.host,
      port: target.port ?? 3306,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: target.ssl === true ? {} : (target.ssl as Record<string, unknown>) || undefined,
      multipleStatements: false,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      charset: 'utf8mb4',
      connectTimeout: 8000,
    });

    const [versionRows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS v');
    const serverVersion = String((versionRows[0] as { v: string }).v);
    const isMariaDb = /mariadb/i.test(serverVersion);
    const timeoutMs = target.policy.limits.timeoutMs;

    if (target.readonlySession) {
      try {
        await connection.query('SET SESSION TRANSACTION READ ONLY');
      } catch {
        // older servers: rely on account grants only
      }
    }

    try {
      if (isMariaDb) {
        await connection.query(`SET SESSION max_statement_time = ${(timeoutMs / 1000).toFixed(3)}`);
      } else {
        await connection.query(`SET SESSION MAX_EXECUTION_TIME = ${Math.trunc(timeoutMs)}`);
      }
    } catch {
      // not fatal: the client-side timeout still applies
    }

    return new MysqlSession(connection, serverVersion, isMariaDb, timeoutMs);
  }

  async listTables(schemas: string[], pattern?: string): Promise<TableInfo[]> {
    const where: string[] = [];
    const params: unknown[] = [];

    if (schemas.length > 0) {
      where.push(`table_schema IN (${schemas.map(() => '?').join(',')})`);
      params.push(...schemas);
    } else {
      where.push('table_schema = DATABASE()');
    }
    if (pattern) {
      where.push('table_name LIKE ?');
      params.push(pattern);
    }

    const sql = `SELECT table_schema, table_name, table_type, table_rows, table_comment
                 FROM information_schema.tables
                 WHERE ${where.join(' AND ')}
                 ORDER BY table_schema, table_name
                 LIMIT ${TABLE_LIMIT}`;

    const [rows] = await this.connection.query<RowDataPacket[]>(sql, params);
    return rows.map((row) => ({
      schema: String(row.table_schema),
      table: String(row.table_name),
      type: String(row.table_type),
      estimatedRows: row.table_rows === null ? null : Number(row.table_rows),
      comment: String(row.table_comment || ''),
    }));
  }

  async describeTable(schema: string | undefined, table: string): Promise<Record<string, unknown>> {
    const targetSchema = schema || (await this.currentSchema());

    const [columns] = await this.connection.query<RowDataPacket[]>(
      `SELECT column_name, column_type, is_nullable, column_key, column_default, extra, column_comment
       FROM information_schema.columns
       WHERE table_schema = ? AND table_name = ?
       ORDER BY ordinal_position`,
      [targetSchema, table],
    );

    if (columns.length === 0) {
      throw new Error(`表 ${targetSchema}.${table} 不存在或当前账号无权访问`);
    }

    const [indexes] = await this.connection.query<RowDataPacket[]>(
      `SELECT index_name, non_unique, seq_in_index, column_name
       FROM information_schema.statistics
       WHERE table_schema = ? AND table_name = ?
       ORDER BY index_name, seq_in_index`,
      [targetSchema, table],
    );

    const [foreignKeys] = await this.connection.query<RowDataPacket[]>(
      `SELECT constraint_name, column_name, referenced_table_schema,
              referenced_table_name, referenced_column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND table_name = ? AND referenced_table_name IS NOT NULL`,
      [targetSchema, table],
    );

    return {
      schema: targetSchema,
      table,
      columns: columns.map<ColumnInfo>((row) => ({
        column: String(row.column_name),
        type: String(row.column_type),
        nullable: String(row.is_nullable).toUpperCase() === 'YES',
        key: String(row.column_key || ''),
        default: row.column_default ?? null,
        extra: String(row.extra || ''),
        comment: String(row.column_comment || ''),
      })),
      indexes: indexes.map((row) => ({
        name: String(row.index_name),
        unique: Number(row.non_unique) === 0,
        column: String(row.column_name),
        position: Number(row.seq_in_index),
      })),
      foreignKeys: foreignKeys.map((row) => ({
        name: String(row.constraint_name),
        column: String(row.column_name),
        references: `${row.referenced_table_schema}.${row.referenced_table_name}.${row.referenced_column_name}`,
      })),
    };
  }

  async searchColumns(
    keyword: string,
    schemas: string[],
    limit: number,
  ): Promise<
    Array<{ schema: string; table: string; column: string; type: string; comment: string }>
  > {
    const safeLimit = Math.max(1, Math.min(limit, 200));
    const like = `%${keyword.replace(/[\\.%_]/g, '\\$&')}%`;
    const where: string[] = [];
    const params: unknown[] = [];

    if (schemas.length > 0) {
      where.push(`table_schema IN (${schemas.map(() => '?').join(',')})`);
      params.push(...schemas);
    } else {
      where.push('table_schema = DATABASE()');
    }
    where.push('(column_name LIKE ? OR column_comment LIKE ?)');
    params.push(like, like);

    const sql = `SELECT table_schema, table_name, column_name, column_type, column_comment
                 FROM information_schema.columns
                 WHERE ${where.join(' AND ')}
                 ORDER BY table_schema, table_name, ordinal_position
                 LIMIT ${safeLimit}`;

    const [rows] = await this.connection.query<RowDataPacket[]>(sql, params);
    return rows.map((row) => ({
      schema: String(row.table_schema),
      table: String(row.table_name),
      column: String(row.column_name),
      type: String(row.column_type),
      comment: String(row.column_comment || ''),
    }));
  }

  async query(sql: string, maxRows: number): Promise<QueryResult> {
    const [rows, fields] = (await this.connection.query({
      sql,
      timeout: this.timeoutMs,
    } as never)) as [RowDataPacket[] | Record<string, unknown>, FieldPacket[] | undefined];

    if (Array.isArray(rows)) {
      const columns = (fields || []).map((field) => field.name);
      const truncated = rows.length > maxRows;
      return {
        columns,
        rows: rows.slice(0, maxRows) as Record<string, unknown>[],
        rowCount: rows.length,
        truncated,
      };
    }

    return { columns: [], rows: [], rowCount: 0, truncated: false };
  }

  private async currentSchema(): Promise<string> {
    const [rows] = await this.connection.query<RowDataPacket[]>('SELECT DATABASE() AS db');
    const value = (rows[0] as { db: string | null }).db;
    if (!value) throw new Error('连接未指定数据库，请传入 schema');
    return value;
  }

  /** Raw execution used by `dbmcp doctor` probes. Bypasses the SQL guard on purpose. */
  async exec(sql: string): Promise<unknown> {
    const [rows] = await this.connection.query({ sql, timeout: this.timeoutMs } as never);
    return rows;
  }

  async close(): Promise<void> {
    try {
      await this.connection.end();
    } catch {
      // already closed
    }
  }
}
