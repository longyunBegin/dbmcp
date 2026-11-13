import path from 'node:path';
import { installedClients, detectClients, installClient, clientInfo, snippet, ALL_CLIENTS, ClientId } from '../ide';
import { fail, heading, info, ok, warn } from '../ui';

export interface InstallOptions {
  client?: string;
  print?: boolean;
}

export function installCommand(options: InstallOptions): void {
  const entryPath = path.resolve(__dirname, '..', 'index.js');

  heading('dbmcp install');
  info(`服务入口  ${entryPath}`);
  info('写入位置  IDE 用户级配置（不在项目目录内）');

  if (options.print) {
    console.log(`\n${snippet(entryPath)}\n`);
    return;
  }

  const requested = options.client
    ? (options.client
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean) as ClientId[])
    : detectClients();

  const unknown = requested.filter((id) => !ALL_CLIENTS.includes(id));
  if (unknown.length > 0) {
    warn(`未知客户端已忽略: ${unknown.join(', ')}`);
  }

  const targets = requested.filter((id) => ALL_CLIENTS.includes(id));
  if (targets.length === 0) {
    warn('未检测到可自动配置的客户端，以下片段可手动粘贴：');
    console.log(`\n${snippet(entryPath)}\n`);
    return;
  }

  for (const id of targets) {
    const info_ = clientInfo(id);
    if (info_.scope === 'manual' || !info_.file) {
      warn(`${info_.label} 需要手动配置，请粘贴以下片段：`);
      console.log(`\n${snippet(entryPath)}\n`);
      continue;
    }
    try {
      const result = installClient(id, entryPath);
      ok(`${info_.label}  →  ${result.file}`);
      if (result.backup) info(`  备份: ${result.backup}`);
    } catch (error) {
      fail(`${info_.label}: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }

  heading('安装完成');
  info('已安装的客户端可随时用 dbmcp uninstall 还原');
}

export function installStatusCommand(): void {
  const installed = installedClients();
  heading('已安装的客户端');
  if (installed.length === 0) {
    info('（空）运行 dbmcp install 开始');
    return;
  }
  for (const item of installed) info(`- ${item.id}  ${item.file}`);
}

/** Remove the dbmcp entry from every client we previously touched. */
export function uninstallCommand(): void {
  const installed = installedClients();
  heading('dbmcp uninstall');
  if (installed.length === 0) {
    warn('没有记录到已安装的客户端');
    return;
  }
  // Imported lazily to keep startup cheap for other commands.
  const { uninstallClient } = require('../ide') as typeof import('../ide');
  for (const item of installed) {
    const result = uninstallClient(item.id as ClientId);
    if (!result) {
      warn(`${item.id}: 配置文件已不存在`);
      continue;
    }
    ok(`${item.id}: ${result.removed ? '已移除 dbmcp 条目' : '未找到 dbmcp 条目'}  ${result.file}`);
  }
  info('你的项目目录始终未被修改');
}
