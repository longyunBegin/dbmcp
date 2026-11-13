import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionConfig } from './config';
import { ensureDir, secretsDir } from './paths';

export interface SecretResolution {
  password?: string;
  source: string;
  warning?: string;
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/;

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readEnvFile(file: string): Record<string, string> {
  try {
    if (!fs.existsSync(file)) return {};
    return parseEnvFile(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function storedSecretFile(slug: string): string {
  return path.join(secretsDir(), `${slug}.json`);
}

function readStoredSecrets(slug: string): Record<string, string> {
  try {
    const file = storedSecretFile(slug);
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function tightenPermissions(file: string): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      // best effort: the file is still inside the user profile
    }
    return;
  }
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function storeSecret(slug: string, name: string, value: string): string {
  ensureDir(secretsDir());
  const file = storedSecretFile(slug);
  const data = readStoredSecrets(slug);
  data[name] = value;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  tightenPermissions(file);
  return file;
}

export function listStoredSecrets(slug: string): string[] {
  return Object.keys(readStoredSecrets(slug));
}

export function removeSecret(slug: string, name: string): boolean {
  const file = storedSecretFile(slug);
  const data = readStoredSecrets(slug);
  if (!(name in data)) return false;
  delete data[name];
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  tightenPermissions(file);
  return true;
}

export interface ResolveSecretOptions {
  slug: string;
  /** Project root, used only for read-only consumption of existing .env files. */
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

function resolveVariable(
  name: string,
  env: NodeJS.ProcessEnv,
  envFiles: string[],
): SecretResolution | undefined {
  const fromProcess = env[name];
  if (fromProcess !== undefined) return { password: fromProcess, source: `env:${name}` };

  for (const file of envFiles) {
    const values = readEnvFile(file);
    if (values[name] !== undefined) {
      return { password: values[name], source: `envfile:${path.basename(file)}` };
    }
  }
  return undefined;
}

/**
 * Resolution order is fixed and documented:
 * plaintext (opt-in) -> secretRef -> ${VAR} -> passwordEnv -> envFile -> project .env -> stored secret.
 */
export function resolvePassword(conn: ConnectionConfig, options: ResolveSecretOptions): SecretResolution {
  const env = options.env ?? process.env;
  const envFiles = [
    ...(conn.envFile || []).map((file) => path.resolve(options.projectRoot || process.cwd(), file)),
    ...(options.projectRoot
      ? [path.join(options.projectRoot, '.env'), path.join(options.projectRoot, '.env.local')]
      : []),
  ];

  if (conn.password) {
    const placeholder = PLACEHOLDER.exec(conn.password);
    if (placeholder) {
      const varName = placeholder[1];
      const resolved = resolveVariable(varName, env, envFiles);
      if (resolved) return resolved;
      if (placeholder[2] !== undefined) {
        return { password: placeholder[2], source: `default:${varName}` };
      }
      return { source: 'unresolved', warning: `环境变量 ${varName} 未设置` };
    }
    if (conn.allowPlaintext) {
      return { password: conn.password, source: 'plaintext' };
    }
    return {
      password: conn.password,
      source: 'plaintext',
      warning: '配置中存在明文密码，建议改用 secretRef（dbmcp secret set）',
    };
  }

  if (conn.secretRef) {
    const [scheme, ...rest] = conn.secretRef.split(':');
    const target = rest.join(':');
    if (scheme === 'env') {
      const resolved = resolveVariable(target, env, envFiles);
      return resolved ?? { source: 'unresolved', warning: `环境变量 ${target} 未设置` };
    }
    const stored = readStoredSecrets(options.slug)[target || 'default'];
    if (stored !== undefined) return { password: stored, source: `stored:${target || 'default'}` };
    return { source: 'unresolved', warning: `secretRef "${conn.secretRef}" 未找到，运行 dbmcp secret set <连接名>` };
  }

  if (conn.passwordEnv) {
    const resolved = resolveVariable(conn.passwordEnv, env, envFiles);
    return resolved ?? { source: 'unresolved', warning: `环境变量 ${conn.passwordEnv} 未设置` };
  }

  const stored = readStoredSecrets(options.slug);
  if (stored.default !== undefined) return { password: stored.default, source: 'stored:default' };
  return { source: 'none' };
}
