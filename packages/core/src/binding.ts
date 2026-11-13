import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  findGitRoot,
  normalizePath,
  projectConfigPath,
  projectDir,
  projectsDir,
  shortHash,
  slugify,
} from './paths';

export interface BindingInfo {
  /** Stable directory name under ~/.dbmcp/projects */
  slug: string;
  /** Directory the agent was opened in (or its git root) */
  root: string;
  gitRoot?: string;
  gitRemote?: string;
  source: 'git-remote' | 'git-root' | 'path';
}

export function readGitRemote(dir: string): string | undefined {
  try {
    const result = spawnSync('git', ['-C', dir, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    if (result.status === 0) {
      const url = (result.stdout || '').trim();
      return url || undefined;
    }
  } catch {
    // git missing or not a repo: caller falls back to path-based identity
  }
  return undefined;
}

export function repoNameFromRemote(remote: string): string {
  const cleaned = remote.replace(/\.git$/, '').replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/:]/).filter(Boolean);
  return parts[parts.length - 1] || 'project';
}

/**
 * Slug is derived from the git remote when available, so the same repository
 * on Windows and macOS maps to the same directory and config stays portable.
 */
export function computeBinding(root: string): BindingInfo {
  const gitRoot = findGitRoot(root);
  const gitRemote = gitRoot ? readGitRemote(gitRoot) : undefined;
  const base = gitRoot || path.resolve(root);

  if (gitRemote) {
    return {
      slug: `${slugify(repoNameFromRemote(gitRemote))}-${shortHash(gitRemote)}`,
      root: path.resolve(root),
      gitRoot,
      gitRemote,
      source: 'git-remote',
    };
  }

  if (gitRoot) {
    return {
      slug: `${slugify(path.basename(gitRoot))}-${shortHash(normalizePath(gitRoot))}`,
      root: path.resolve(root),
      gitRoot,
      source: 'git-root',
    };
  }

  return {
    slug: `${slugify(path.basename(base))}-${shortHash(normalizePath(base))}`,
    root: base,
    source: 'path',
  };
}

/** Look up an existing binding for a directory, tolerating moved clones. */
export function resolveBinding(startDir: string): BindingInfo | undefined {
  const direct = computeBinding(startDir);
  if (fs.existsSync(projectConfigPath(direct.slug))) return direct;

  const dir = projectsDir();
  if (!fs.existsSync(dir)) return undefined;

  const targetPath = normalizePath(direct.gitRoot || direct.root);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = projectConfigPath(entry.name);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) as {
        binding?: { gitRemote?: string; path?: string };
      };
      const binding = parsed?.binding ?? {};
      if (direct.gitRemote && binding.gitRemote === direct.gitRemote) {
        return {
          ...direct,
          slug: entry.name,
          gitRemote: direct.gitRemote,
          source: 'git-remote',
        };
      }
      if (binding.path && normalizePath(binding.path) === targetPath) {
        return { ...direct, slug: entry.name, source: direct.source };
      }
    } catch {
      // unreadable config: ignore this candidate
    }
  }
  return undefined;
}

export { projectDir, projectConfigPath };
