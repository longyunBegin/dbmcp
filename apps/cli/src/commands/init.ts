import fs from 'node:fs';
import path from 'node:path';
import {
  computeBinding,
  ensureDir,
  projectConfigPath,
  projectDir,
  resolveBinding,
  storeSecret,
} from '@dbmcp/core';
import YAML from 'yaml';
import { confirm, fail, heading, info, ok, prompt, promptHidden, warn } from '../ui';

export interface InitOptions {
  dir?: string;
  engine?: string;
  name?: string;
  host?: string;
  port?: string;
  database?: string;
  user?: string;
  password?: string;
  url?: string;
  production?: boolean;
  schema?: string;
  keyPrefix?: string;
  nonInteractive?: boolean;
  ssl?: boolean;
}

export async function initCommand(options: InitOptions): Promise<void> {
  const dir = path.resolve(options.dir || process.cwd());
  if (!fs.existsSync(dir)) {
    fail(`目录不存在: ${dir}`);
    process.exitCode = 1;
    return;
  }

  const binding = resolveBinding(dir) || computeBinding(dir);
  const file = projectConfigPath(binding.slug);

  heading('dbmcp init');
  info(`项目目录  ${dir}`);
  info(`绑定标识  ${binding.slug}  (${binding.source})`);
  info(`配置写入  ${file}`);
  info('项目目录不会写入任何文件');

  if (fs.existsSync(file)) {
    if (options.nonInteractive) {
      fail('该项目已绑定；如需修改请使用 dbmcp edit');
      process.exitCode = 1;
      return;
    }
    const overwrite = await confirm('该项目已存在绑定配置，覆盖？', false);
    if (!overwrite) {
      warn('已取消');
      return;
    }
  }

  const ask = async (question: string, defaultValue = ''): Promise<string> => {
    if (options.nonInteractive) return defaultValue;
    return prompt(question, defaultValue);
  };

  const engine = (options.engine || (await ask('引擎 (mysql/redis)', 'mysql'))).toLowerCase();
  if (engine !== 'mysql' && engine !== 'redis') {
    fail(`不支持的引擎: ${engine}`);
    process.exitCode = 1;
    return;
  }

  const name = options.name || (await ask('连接名', engine === 'mysql' ? 'main' : 'cache'));
  let host = options.host;
  let port = options.port;
  let database = options.database;
  let user = options.user;
  let url = options.url;
  let keyPrefix = options.keyPrefix;
  let schema = options.schema;
  let password = options.password;

  if (engine === 'mysql') {
    host = host || (await ask('主机', '127.0.0.1'));
    port = port || (await ask('端口', '3306'));
    database = database || (await ask('数据库名', ''));
    user = user || (await ask('用户名（建议使用只读账号）', ''));
    schema = schema ?? (await ask('可见 schema（逗号分隔，留空=默认库）', ''));
  } else {
    url = url || (await ask('Redis 地址', 'redis://127.0.0.1:6379/0'));
    host = host || '';
    port = port || '6379';
    keyPrefix = keyPrefix ?? (await ask('允许访问的 key 前缀（逗号分隔，留空=全部）', ''));
  }

  if (engine === 'mysql' && !host) {
    fail('缺少主机地址');
    process.exitCode = 1;
    return;
  }

  let production = options.production;
  if (production === undefined && !options.nonInteractive) {
    production = await confirm('这是生产库吗？（选是则默认拒绝访问，需 --allow-prod）', false);
  }

  if (!password && !options.nonInteractive) {
    password = await promptHidden('密码（输入不回显）: ');
  }

  const connection: Record<string, unknown> = { engine };
  if (engine === 'mysql') {
    connection.host = host;
    connection.port = Number(port) || 3306;
    connection.database = database;
    connection.user = user;
    connection.schemas = (schema || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    connection.readonlySession = true;
  } else {
    connection.url = url;
    connection.keyPrefixes = (keyPrefix || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  connection.policy = 'read';
  connection.production = Boolean(production);
  connection.secretRef = `file:${name}`;
  if (options.ssl) connection.ssl = true;

  const config = {
    version: 1,
    binding: {
      ...(binding.gitRemote ? { gitRemote: binding.gitRemote } : {}),
      path: binding.gitRoot || binding.root,
    },
    defaultPolicy: 'read',
    connections: { [name]: connection },
  };

  ensureDir(projectDir(binding.slug));
  const header =
    '# dbmcp 项目配置\n# 该文件位于 ~/.dbmcp，不在你的项目目录内，也不会被提交到 git\n';
  fs.writeFileSync(file, header + YAML.stringify(config, { lineWidth: 0 }), 'utf8');
  ok(`配置已写入 ${file}`);

  if (password) {
    storeSecret(binding.slug, name, password);
    ok(`密码已保存到 ~/.dbmcp/secrets/${binding.slug}.json（权限已收紧）`);
  } else {
    warn(`未设置密码，稍后执行: dbmcp secret set ${name}`);
  }

  heading('下一步');
  info('1. dbmcp install   —— 写入 IDE 用户级 MCP 配置');
  info('2. 打开项目，让 agent 调用 db_list_connections');
  info('3. dbmcp doctor    —— 验证只读是否真实生效');
}
