import { spawn } from 'node:child_process';
import { openProject } from '@dbmcp/core';
import { fail, info } from '../ui';

export function editCommand(dir?: string): void {
  let project;
  try {
    project = openProject(dir || process.cwd());
  } catch (error) {
    fail((error as Error).message);
    process.exitCode = 1;
    return;
  }
  if (!project) {
    fail('当前目录未绑定 dbmcp，先运行 dbmcp init');
    process.exitCode = 1;
    return;
  }

  const editor =
    process.env.EDITOR || process.env.VISUAL || (process.platform === 'win32' ? 'notepad' : 'vi');
  info(`打开 ${project.file}`);
  const child = spawn(editor, [project.file], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  child.on('exit', (code) => {
    if (code && code !== 0) process.exitCode = code;
  });
}
