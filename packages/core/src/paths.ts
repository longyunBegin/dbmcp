import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of all dbmcp state. Always outside any user project. */
export function dbmcpHome(): string {
  return process.env.DBMCP_HOME || path.join(os.homedir(), '.dbmcp');
}

export function projectsDir(): string {
  return path.join(dbmcpHome(), 'projects');
}

export function secretsDir(): string {
  return path.join(dbmcpHome(), 'secrets');
}

export function projectDir(slug: string): string {
  return path.join(projectsDir(), slug);
}

export function projectConfigPath(slug: string): string {
  return path.join(projectDir(slug), 'project.yaml');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Normalize a path for identity comparison. Case-insensitive on win32/darwin. */
export function normalizePath(input: string): string {
  const resolved = path.resolve(input);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLowerCase()
    : resolved;
}

export function shortHash(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6);
}

export function slugify(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned || 'project';
}

/** Walk up from `start` looking for a `.git` entry (directory or worktree file). */
export function findGitRoot(start: string): string | undefined {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
