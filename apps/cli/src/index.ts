#!/usr/bin/env node
import { Command } from 'commander';
import { doctorCommand } from './commands/doctor';
import { editCommand } from './commands/edit';
import { initCommand } from './commands/init';
import { installCommand, installStatusCommand, uninstallCommand } from './commands/install';
import { secretListCommand, secretRemoveCommand, secretSetCommand } from './commands/secret';
import { serveCommand } from './commands/serve';

async function run(action: () => Promise<void> | void): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(`ERROR: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const program = new Command();

program
  .name('dbmcp')
  .version('0.1.0')
  .description('Read-only MySQL / Redis access for any MCP-capable coding agent, with zero project footprint.');

program
  .command('init')
  .description('在当前项目绑定数据库连接（只写 ~/.dbmcp，不写项目目录）')
  .option('-d, --dir <dir>', '目标项目目录')
  .option('-e, --engine <engine>', 'mysql | redis')
  .option('-n, --name <name>', '连接名')
  .option('--host <host>', '主机')
  .option('--port <port>', '端口')
  .option('--database <database>', '数据库名')
  .option('--user <user>', '用户名（建议只读账号）')
  .option('--password <password>', '密码（不推荐，优先用交互输入）')
  .option('--url <url>', 'Redis 地址，例如 redis://127.0.0.1:6379/0')
  .option('--schema <list>', '可见 schema，逗号分隔')
  .option('--key-prefix <list>', '允许访问的 Redis key 前缀，逗号分隔')
  .option('--production', '标记为生产库（默认拒绝访问）')
  .option('--non-interactive', '不进行任何交互输入')
  .action((options) => run(() => initCommand(options)));

program
  .command('bind <dir>')
  .description('显式绑定一个项目目录（等价于 init --dir）')
  .action((dir) => run(() => initCommand({ dir })));

program
  .command('edit')
  .description('用 $EDITOR 打开当前项目的配置')
  .option('-d, --dir <dir>', '目标项目目录')
  .action((options) => run(() => Promise.resolve(editCommand(options.dir))));

program
  .command('secret <action> [name]')
  .description('管理密码：set <连接名> | list | remove <连接名>')
  .option('-d, --dir <dir>', '目标项目目录')
  .option('--value <value>', '直接提供密码（供脚本使用，会留在 shell 历史里）')
  .action((action, name, options) =>
    run(async () => {
      if (action === 'set') {
        if (!name) throw new Error('用法: dbmcp secret set <连接名>');
        await secretSetCommand(name, options);
      } else if (action === 'list') {
        secretListCommand(options);
      } else if (action === 'remove') {
        if (!name) throw new Error('用法: dbmcp secret remove <连接名>');
        secretRemoveCommand(name, options);
      } else {
        throw new Error(`未知动作: ${action}（可用: set / list / remove）`);
      }
    }),
  );

program
  .command('install')
  .description('写入 IDE 用户级 MCP 配置（不在项目目录内）')
  .option('-c, --client <list>', 'cursor,claude,vscode,windsurf,cline,trae，逗号分隔')
  .option('--print', '只打印配置片段，不写文件')
  .action((options) => run(() => Promise.resolve(installCommand(options))));

program
  .command('status')
  .description('查看已安装的 IDE 客户端')
  .action(() => run(() => Promise.resolve(installStatusCommand())));

program
  .command('uninstall')
  .description('从 IDE 用户级配置中移除 dbmcp 条目')
  .action(() => run(() => Promise.resolve(uninstallCommand())));

program
  .command('doctor')
  .description('体检：项目零写入、只读是否真实生效、超时是否生效')
  .option('-d, --dir <dir>', '目标项目目录')
  .option('-c, --connection <name>', '只检查指定连接')
  .option('--allow-prod', '允许探测标记为生产库的连接')
  .action((options) => run(() => doctorCommand(options)));

program
  .command('serve')
  .description('以 stdio 启动 MCP 服务（由 IDE 调用）')
  .option('--allow-prod', '允许访问标记为生产库的连接')
  .option('-d, --dir <dir>', '指定项目目录')
  .action((options) => run(() => serveCommand(options)));

program.parseAsync(process.argv);
