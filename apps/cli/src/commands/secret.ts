import path from 'node:path';
import {
  computeBinding,
  listStoredSecrets,
  removeSecret,
  resolveBinding,
  storeSecret,
} from '@dbmcp/core';
import { fail, heading, info, ok, promptHidden } from '../ui';

function currentSlug(dir?: string): string {
  const target = path.resolve(dir || process.cwd());
  return (resolveBinding(target) || computeBinding(target)).slug;
}

export async function secretSetCommand(name: string, options: { dir?: string; value?: string }): Promise<void> {
  const slug = currentSlug(options.dir);
  const value = options.value || (await promptHidden(`为连接 ${name} 输入密码（不回显）: `));
  if (!value) {
    fail('密码为空，已取消');
    process.exitCode = 1;
    return;
  }
  const file = storeSecret(slug, name, value);
  ok(`已保存连接 ${name} 的密码 → ${file}`);
  info(`配置中应引用: secretRef: file:${name}`);
}

export function secretListCommand(options: { dir?: string }): void {
  const slug = currentSlug(options.dir);
  const names = listStoredSecrets(slug);
  heading(`已保存的密钥 (${slug})`);
  if (names.length === 0) {
    info('（空）使用 dbmcp secret set <连接名> 添加');
    return;
  }
  for (const name of names) info(`- ${name}`);
}

export function secretRemoveCommand(name: string, options: { dir?: string }): void {
  const slug = currentSlug(options.dir);
  const removed = removeSecret(slug, name);
  if (removed) ok(`已删除连接 ${name} 的密码`);
  else fail(`未找到连接 ${name} 的密码`);
}
