import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dbmcpHome, ensureDir } from '@dbmcp/core';

export type ClientId = 'cursor' | 'claude' | 'vscode' | 'windsurf' | 'cline' | 'trae';

export interface ClientInfo {
  id: ClientId;
  label: string;
  scope: 'user' | 'manual';
  file?: string;
  key: string;
  needsType: boolean;
}

interface InstallRecord {
  clients: Record<string, { file: string; hadEntry: boolean }>;
}

function appData(): string {
  return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
}

function vscodeUserDir(): string {
  if (process.platform === 'win32') return path.join(appData(), 'Code', 'User');
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
  }
  return path.join(os.homedir(), '.config', 'Code', 'User');
}

export function clientInfo(id: ClientId): ClientInfo {
  switch (id) {
    case 'cursor':
      return {
        id,
        label: 'Cursor',
        scope: 'user',
        file: path.join(os.homedir(), '.cursor', 'mcp.json'),
        key: 'mcpServers',
        needsType: false,
      };
    case 'claude':
      return {
        id,
        label: 'Claude Code',
        scope: 'user',
        file: path.join(os.homedir(), '.claude.json'),
        key: 'mcpServers',
        needsType: false,
      };
    case 'vscode':
      return {
        id,
        label: 'VS Code (Copilot)',
        scope: 'user',
        file: path.join(vscodeUserDir(), 'mcp.json'),
        key: 'servers',
        needsType: true,
      };
    case 'windsurf':
      return {
        id,
        label: 'Windsurf',
        scope: 'user',
        file: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
        key: 'mcpServers',
        needsType: false,
      };
    case 'cline':
      return {
        id,
        label: 'Cline',
        scope: 'user',
        file: path.join(
          vscodeUserDir(),
          'globalStorage',
          'saoudrizwan.claude-dev',
          'settings',
          'cline_mcp_settings.json',
        ),
        key: 'mcpServers',
        needsType: false,
      };
    case 'trae':
      return { id, label: 'Trae', scope: 'manual', key: 'mcpServers', needsType: false };
  }
}

export const ALL_CLIENTS: ClientId[] = ['cursor', 'claude', 'vscode', 'windsurf', 'cline', 'trae'];

export function detectClients(): ClientId[] {
  return ALL_CLIENTS.filter((id) => {
    const info = clientInfo(id);
    if (!info.file) return false;
    return fs.existsSync(info.file) || fs.existsSync(path.dirname(info.file));
  });
}

export function serverEntry(info: ClientInfo, entryPath: string): Record<string, unknown> {
  const base = { command: process.execPath, args: [entryPath, 'serve'] };
  return info.needsType ? { type: 'stdio', ...base } : base;
}

function readJson(file: string): Record<string, unknown> {
  try {
    if (!fs.existsSync(file)) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch (error) {
    throw new Error(`无法解析 ${file}: ${(error as Error).message}`);
  }
}

export interface InstallResult {
  file: string;
  backup?: string;
  created: boolean;
}

export function installClient(id: ClientId, entryPath: string): InstallResult {
  const info = clientInfo(id);
  if (!info.file) throw new Error(`${info.label} 不支持自动写入，请手动粘贴配置`);
  const file = info.file;
  ensureDir(path.dirname(file));

  const data = readJson(file);
  const bucket =
    data[info.key] && typeof data[info.key] === 'object'
      ? (data[info.key] as Record<string, unknown>)
      : {};

  const hadEntry = Boolean(bucket.dbmcp);
  let backup: string | undefined;
  if (fs.existsSync(file)) {
    backup = `${file}.dbmcp.bak`;
    fs.copyFileSync(file, backup);
  }

  bucket.dbmcp = serverEntry(info, entryPath);
  data[info.key] = bucket;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');

  recordInstall(id, { file, hadEntry });
  return { file, backup, created: !hadEntry };
}

export function uninstallClient(id: ClientId): { file: string; removed: boolean } | undefined {
  const info = clientInfo(id);
  if (!info.file || !fs.existsSync(info.file)) return undefined;
  const data = readJson(info.file);
  const bucket = data[info.key] as Record<string, unknown> | undefined;
  if (!bucket || !bucket.dbmcp) return { file: info.file, removed: false };
  delete bucket.dbmcp;
  data[info.key] = bucket;
  fs.writeFileSync(info.file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return { file: info.file, removed: true };
}

function installRecordFile(): string {
  return path.join(dbmcpHome(), 'install.json');
}

function readInstallRecord(): InstallRecord {
  try {
    const file = installRecordFile();
    if (!fs.existsSync(file)) return { clients: {} };
    return JSON.parse(fs.readFileSync(file, 'utf8')) as InstallRecord;
  } catch {
    return { clients: {} };
  }
}

function recordInstall(id: ClientId, entry: { file: string; hadEntry: boolean }): void {
  const record = readInstallRecord();
  record.clients[id] = entry;
  ensureDir(dbmcpHome());
  fs.writeFileSync(installRecordFile(), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

export function installedClients(): Array<{ id: string; file: string }> {
  const record = readInstallRecord();
  return Object.entries(record.clients).map(([id, value]) => ({ id, file: value.file }));
}

export function snippet(entryPath: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        dbmcp: { command: process.execPath, args: [entryPath, 'serve'] },
      },
    },
    null,
    2,
  );
}
