import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  LiveConnection,
  ProjectContext,
  dbmcpHome,
  openConnection,
  openProject,
} from '@dbmcp/core';
import { MysqlSession } from '@dbmcp/driver-mysql';
import { RedisSession } from '@dbmcp/driver-redis';
import { installedClients } from '../ide';
import { heading, info, table } from '../ui';

type Status = 'PASS' | 'WARN' | 'FAIL';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

export interface DoctorOptions {
  dir?: string;
  connection?: string;
  allowProd?: boolean;
}

export async function doctorCommand(options: DoctorOptions): Promise<void> {
  heading('dbmcp doctor');

  const project = tryOpenProject(options.dir || process.cwd());
  if (!project) {
    console.log('  ✗ 当前目录未绑定 dbmcp，先运行 dbmcp init');
    process.exitCode = 1;
    return;
  }

  info(`项目    ${project.root}`);
  info(`绑定    ${project.binding.slug}  (${project.binding.source})`);
  info(`配置    ${project.file}`);

  const checks: Check[] = [];

  const home = path.resolve(dbmcpHome());
  const root = path.resolve(project.root);
  const homeInsideProject = home === root || home.startsWith(`${root}${path.sep}`);
  checks.push({
    name: '配置外置',
    status: homeInsideProject ? 'FAIL' : 'PASS',
    detail: homeInsideProject ? '状态目录位于项目内，违反无嵌入约束' : '状态全部位于 ~/.dbmcp',
  });

  const strayYaml = fs.existsSync(path.join(root, 'dbmcp.yaml'));
  checks.push({
    name: '项目零文件',
    status: strayYaml ? 'WARN' : 'PASS',
    detail: strayYaml ? '项目根存在 dbmcp.yaml（非本工具生成，请自行确认）' : '项目根无 dbmcp 文件',
  });

  const git = spawnSync('git', ['-C', root, 'status', '--porcelain'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (git.status === 0) {
    const dirty = (git.stdout || '').trim();
    checks.push({
      name: 'git 工作区',
      status: dirty ? 'WARN' : 'PASS',
      detail: dirty ? '存在未提交改动（不一定与本工具相关）' : '干净',
    });
  } else {
    checks.push({ name: 'git 工作区', status: 'WARN', detail: '不是 git 仓库或未安装 git' });
  }

  const names = options.connection
    ? [options.connection]
    : Object.keys(project.config.connections);

  for (const name of names) {
    await probeConnection(project, name, options, checks);
  }

  const installed = installedClients();
  checks.push({
    name: 'IDE 配置',
    status: installed.length > 0 ? 'PASS' : 'WARN',
    detail:
      installed.length > 0
        ? installed.map((item) => item.id).join(', ')
        : '尚未运行 dbmcp install',
  });

  console.log('');
  table([
    ['检查项', '结果', '说明'],
    ...checks.map((check) => [check.name, check.status, check.detail]),
  ]);

  const failed = checks.filter((check) => check.status === 'FAIL').length;
  const warned = checks.filter((check) => check.status === 'WARN').length;
  console.log(`\n  ${checks.length - failed - warned} PASS / ${warned} WARN / ${failed} FAIL`);
  if (failed > 0) process.exitCode = 1;
}

async function probeConnection(
  project: ProjectContext,
  name: string,
  options: DoctorOptions,
  checks: Check[],
): Promise<void> {
  let target: LiveConnection;
  try {
    const opened = openConnection(project, name);
    target = opened.connection;
    if (target.production && !options.allowProd) {
      checks.push({
        name: `${name} 连接`,
        status: 'WARN',
        detail: '标记为生产库，已跳过探测（加 --allow-prod 可强制体检）',
      });
      return;
    }
    if (!opened.secret.password && target.engine === 'mysql') {
      checks.push({
        name: `${name} 连接`,
        status: 'FAIL',
        detail: opened.secret.warning || `缺少密码，执行 dbmcp secret set ${name}`,
      });
      return;
    }
  } catch (error) {
    checks.push({ name: `${name} 配置`, status: 'FAIL', detail: (error as Error).message });
    return;
  }

  if (target.engine === 'mysql') {
    await probeMysql(name, target, checks);
  } else {
    await probeRedis(name, target, checks);
  }
}

async function probeMysql(name: string, target: LiveConnection, checks: Check[]): Promise<void> {
  let session: MysqlSession;
  try {
    session = await MysqlSession.open(target);
  } catch (error) {
    checks.push({ name: `${name} 连接`, status: 'FAIL', detail: (error as Error).message });
    return;
  }

  checks.push({
    name: `${name} 连接`,
    status: 'PASS',
    detail: `${target.database ?? ''} @ ${target.host}:${target.port ?? 3306}`,
  });

  let writable = false;
  try {
    await session.exec('CREATE TEMPORARY TABLE dbmcp_probe (id INT)');
    writable = true;
  } catch {
    writable = false;
  }
  if (writable) {
    try {
      await session.exec('DROP TEMPORARY TABLE dbmcp_probe');
    } catch {
      // session-scoped anyway
    }
  }
  checks.push({
    name: `${name} 只读`,
    status: writable ? 'WARN' : 'PASS',
    detail: writable
      ? '账号仍具备写权限，只读目前只依赖会话只读 + 语句闸门'
      : '写操作被数据库拒绝',
  });

  const startedAt = Date.now();
  let interrupted = false;
  try {
    await session.exec('SELECT SLEEP(30)');
  } catch {
    interrupted = Date.now() - startedAt < 20_000;
  }
  checks.push({
    name: `${name} 超时`,
    status: interrupted ? 'PASS' : 'WARN',
    detail: interrupted
      ? `慢查询在 ${Date.now() - startedAt}ms 被中断`
      : 'SLEEP 未被中断，服务端超时可能未生效',
  });

  await session.close();
}

async function probeRedis(name: string, target: LiveConnection, checks: Check[]): Promise<void> {
  let session: RedisSession;
  try {
    session = await RedisSession.open(target);
  } catch (error) {
    checks.push({ name: `${name} 连接`, status: 'FAIL', detail: (error as Error).message });
    return;
  }

  try {
    const detail = await session.info();
    checks.push({
      name: `${name} 连接`,
      status: 'PASS',
      detail: `redis ${detail.redisVersion}, dbsize=${detail.dbsize}`,
    });
  } catch (error) {
    checks.push({ name: `${name} 连接`, status: 'FAIL', detail: (error as Error).message });
    await session.close();
    return;
  }

  let writable = false;
  try {
    await session.raw('SET', 'dbmcp:probe', String(Date.now()));
    writable = true;
  } catch {
    writable = false;
  }
  if (writable) {
    try {
      await session.raw('DEL', 'dbmcp:probe');
    } catch {
      // ignore cleanup failure
    }
  }
  checks.push({
    name: `${name} 只读`,
    status: writable ? 'WARN' : 'PASS',
    detail: writable
      ? '账号仍可写入，建议改用 ACL 只读账号（-@all +@read +@connection）'
      : '写命令被拒绝',
  });

  await session.close();
}

function tryOpenProject(dir: string): ProjectContext | undefined {
  try {
    return openProject(dir);
  } catch {
    return undefined;
  }
}
