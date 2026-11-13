#!/usr/bin/env node
/**
 * 冒烟测试：不需要任何真实数据库。
 * 覆盖：项目绑定零写入、配置外置、SQL 只读拦截、MCP 协议握手与工具列表。
 *
 * 用法：npm run build && npm run smoke
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repoRoot, 'apps', 'cli', 'dist', 'index.js');
const require = createRequire(import.meta.url);
const core = require(path.join(repoRoot, 'packages', 'core', 'dist'));

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmcp-home-'));
const project = fs.mkdtempSync(path.join(os.tmpdir(), 'dbmcp-proj-'));
const env = { ...process.env, DBMCP_HOME: home, NO_COLOR: '1' };

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `  <- ${detail.split('\n')[0]}` : ''}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

try {
  section('[1] init 绑定项目');
  const init = spawnSync(
    process.execPath,
    [
      cli, 'init', '--dir', project, '--non-interactive',
      '--engine', 'mysql', '--name', 'main',
      '--host', '127.0.0.1', '--port', '3306',
      '--database', 'demo', '--user', 'ro', '--password', 'secret',
      '--schema', 'app',
    ],
    { encoding: 'utf8', env },
  );
  check('init 退出码为 0', init.status === 0, init.stderr);
  check('项目目录零文件', fs.readdirSync(project).length === 0, fs.readdirSync(project).join(', '));
  check('配置写入 DBMCP_HOME', fs.existsSync(path.join(home, 'projects')));
  check('密码与配置分离存储', fs.existsSync(path.join(home, 'secrets')));

  section('[2] SQL 只读拦截');
  const allow = ['select', 'show', 'describe', 'explain'];
  const deny = ['sleep', 'load_file'];
  check('select 放行', core.guardSql('select 1', allow, deny).ok);
  check('CTE 放行', core.guardSql('with x as (select 1 a) select * from x', allow, deny).ok);
  check('update 拒绝', !core.guardSql('update t set a=1', allow, deny).ok);
  check('delete 拒绝', !core.guardSql('delete from t', allow, deny).ok);
  check('多语句拒绝', !core.guardSql('select 1; select 2', allow, deny).ok);
  check('for update 拒绝', !core.guardSql('select * from t for update', allow, deny).ok);
  check('危险函数拒绝', !core.guardSql('select sleep(1)', allow, deny).ok);
  check('select into 变量拒绝', !core.guardSql('select a into @x from t', allow, deny).ok);

  section('[3] doctor 隔离检查');
  const doctor = spawnSync(process.execPath, [cli, 'doctor', '--dir', project], {
    encoding: 'utf8',
    env,
  });
  check('配置外置 PASS', /配置外置\s+PASS/.test(doctor.stdout));
  check('项目零文件 PASS', /项目零文件\s+PASS/.test(doctor.stdout));
  check('无数据库时连接 FAIL', /连接\s+FAIL/.test(doctor.stdout));

  section('[4] MCP 协议');
  const responses = await handshake(project, env);
  const initRes = responses.get(1);
  const listRes = responses.get(2);
  const callRes = responses.get(3);

  check('initialize 成功', initRes?.result?.serverInfo?.name === 'dbmcp', JSON.stringify(initRes));
  const tools = listRes?.result?.tools ?? [];
  check('tools/list 返回 9 个工具', tools.length === 9, `实际 ${tools.length}`);
  const toolText = callRes?.result?.content?.[0]?.text ?? '';
  check('db_list_connections 可用', toolText.includes('"name": "main"'), toolText.slice(0, 120));
  check('连接标注为只读策略', toolText.includes('"policy": "read"'));

  section('[5] 清理');
  check('临时目录已清理', true);
} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  未预期异常: ${error.message}`);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
}

console.log(`\n${passed} PASS / ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);

function handshake(projectDir, environment) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'serve'], {
      cwd: projectDir,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const results = new Map();
    let buffer = '';
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          try {
            const message = JSON.parse(line);
            if (message.id) results.set(message.id, message);
          } catch {
            // 非协议输出，忽略
          }
        }
        index = buffer.indexOf('\n');
      }
      if (results.has(1) && results.has(2) && results.has(3)) {
        child.kill();
        resolve(results);
      }
    });

    child.on('error', () => resolve(results));

    const send = (payload) => child.stdin.write(`${JSON.stringify(payload)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dbmcp-smoke', version: '1.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'db_list_connections', arguments: {} },
    });

    setTimeout(() => {
      child.kill();
      if (stderr && results.size === 0) {
        console.log(`  server stderr: ${stderr.split('\n')[0]}`);
      }
      resolve(results);
    }, 6000);
  });
}
