import { openProject, resolvePassword } from '@dbmcp/core';
import { heading, info, table } from '../ui';

export interface ListOptions {
  dir?: string;
  env?: string;
}

export function listCommand(options: ListOptions): void {
  const project = openProject(options.dir || process.cwd());
  if (!project) {
    throw new Error('当前目录未绑定 dbmcp，先运行 dbmcp init');
  }

  heading('dbmcp list');
  info(`项目  ${project.root}`);
  info(`绑定  ${project.binding.slug}`);

  const groups = new Map<
    string,
    Array<{ name: string; engine: string; target: string; database: string; schemas: string; secret: string }>
  >();

  for (const [name, conn] of Object.entries(project.config.connections)) {
    const env = conn.environment ?? (conn.production ? 'prod' : '未标注');
    if (options.env && options.env.toLowerCase() !== env.toLowerCase()) continue;

    const secret = resolvePassword(conn, {
      slug: project.binding.slug,
      projectRoot: project.root,
    });
    const target = conn.url
      ? conn.url.replace(/\/\/[^@/]*@/, '//')
      : `${conn.host ?? 'localhost'}${conn.port ? `:${conn.port}` : ''}`;
    const rows = groups.get(env) ?? [];
    rows.push({
      name,
      engine: conn.engine,
      target,
      database: conn.database ?? '-',
      schemas: conn.schemas.length > 0 ? conn.schemas.join(', ') : '全部',
      secret: secret.password ? '已保存' : '缺失',
    });
    groups.set(env, rows);
  }

  if (groups.size === 0) {
    info('没有匹配的连接');
    return;
  }

  for (const [env, rows] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log('');
    console.log(`[${env}]`);
    table([
      ['连接名', '引擎', '目标', '默认库', '可见库', '密码'],
      ...rows.map((row) => [row.name, row.engine, row.target, row.database, row.schemas, row.secret]),
    ]);
  }

  console.log('');
  info('只带出 dev/test 用法: dbmcp list --env dev');
}
