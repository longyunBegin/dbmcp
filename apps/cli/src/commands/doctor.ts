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
    detail: `[${environmentTag(target)}] ${target.database ?? ''} @ ${target.host}:${target.port ?? 3306}`,
  });

  // 判断写权限只看 SHOW GRANTS，不建表、不写任何数据
  let grants: string[] = [];
  try {
    grants = await session.grants();
  } catch {
    grants = [];
  }
  const writeGrants = detectWriteGrants(grants, target.database);

  checks.push({
    name: `${name} 只读`,
    status: writeGrants.length > 0 ? 'WARN' : grants.length > 0 ? 'PASS' : 'WARN',
    detail: writeGrants.length > 0
      ? `账号具备写权限: ${describeGrants(writeGrants)}（建议改用只读账号）`
      : grants.length > 0
        ? '仅只读权限（依据 SHOW GRANTS）'
        : '无法读取权限信息，未执行任何写操作',
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

  // 用 ACL DRYRUN 判断写权限，不写入任何 key
  let writable: boolean | undefined;
  try {
    const who = String(await session.raw('ACL', 'WHOAMI'));
    const verdict = await session.raw('ACL', 'DRYRUN', who, 'SET', 'dbmcp:probe', '1');
    writable = String(verdict).toUpperCase() === 'OK';
  } catch {
    writable = undefined;
  }

  checks.push({
    name: `${name} 只读`,
    status: writable === true ? 'WARN' : writable === false ? 'PASS' : 'WARN',
    detail:
      writable === true
        ? '账号允许 SET 命令，建议改用 ACL 只读账号（-@all +@read +@connection）'
        : writable === false
          ? '写命令被 ACL 拒绝'
          : '服务端不支持 ACL DRYRUN（Redis < 7 或 ACL 受限），未执行任何写操作',
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

const WRITE_PRIVILEGE = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|ALL PRIVILEGES)\b/i;

function environmentTag(connection: LiveConnection): string {
  if (connection.environment) return connection.environment;
  return connection.production ? 'prod' : '未标注';
}

function detectWriteGrants(grants: string[], database?: string): string[] {
  return grants.filter((grant) => {
    // MySQL 会把库名里的下划线转义成 \_，比较前先还原
    const normalized = grant.replace(/\\/g, '');
    if (!WRITE_PRIVILEGE.test(normalized)) return false;
    if (!database) return true;
    return (
      normalized.includes('*.*') ||
      normalized.includes(`\`${database}\``) ||
      normalized.includes(`${database}.*`)
    );
  });
}

function describeGrants(grants: string[]): string {
  const verbs = new Set<string>();
  for (const grant of grants) {
    for (const verb of ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE']) {
      if (new RegExp(`\\b${verb}\\b`, 'i').test(grant)) verbs.add(verb);
    }
    if (/\bALL PRIVILEGES\b/i.test(grant)) verbs.add('ALL PRIVILEGES');
  }
  return [...verbs].join(', ') || '未知';
}
