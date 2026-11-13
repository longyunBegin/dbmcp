import { BindingInfo, resolveBinding } from './binding';
import {
  ProjectConfig,
  ResolvedConnection,
  loadProjectConfig,
  resolveConnection,
  resolvePolicy,
  toResolvedConnection,
} from './config';
import { projectConfigPath } from './paths';
import { SecretResolution, resolvePassword } from './secrets';

export interface ProjectContext {
  binding: BindingInfo;
  config: ProjectConfig;
  file: string;
  /** Root used for read-only .env consumption. */
  root: string;
}

export type LiveConnection = ResolvedConnection & { password?: string };

export interface OpenConnectionResult {
  connection: LiveConnection;
  secret: SecretResolution;
}

export function openProject(startDir: string = process.cwd()): ProjectContext | undefined {
  const binding = resolveBinding(startDir);
  if (!binding) return undefined;
  const file = projectConfigPath(binding.slug);
  const loaded = loadProjectConfig(file);
  return {
    binding,
    config: loaded.config,
    file,
    root: binding.gitRoot || binding.root,
  };
}

export function openConnection(project: ProjectContext, name?: string): OpenConnectionResult {
  const { name: resolvedName, conn } = resolveConnection(project.config, name);
  const policy = resolvePolicy(project.config, conn);
  const resolved = toResolvedConnection(resolvedName, conn, policy);
  const secret = resolvePassword(conn, {
    slug: project.binding.slug,
    projectRoot: project.root,
  });
  return {
    connection: { ...resolved, password: secret.password },
    secret,
  };
}
