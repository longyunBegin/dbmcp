# dbmcp

给任何支持 MCP 的编码 agent 提供**只读**的 MySQL / Redis 访问能力，并且**不在你的项目里留下任何文件**。

- 对接 Cursor、Claude Code、VS Code、Windsurf、Cline、Trae
- 配置与凭据全部放在 `~/.dbmcp/`，项目目录零写入
- 三层只读防护：会话只读事务 + SQL 语句白名单 + 资源上限
- 数据库侧零改动：不建账号、不改结构、不写数据，用你自备的只读账号

## 为什么需要它

把数据库交给 agent，最大的风险不是"连不上"，而是它悄悄改了数据、或者把一次 `SELECT *` 的结果塞满上下文。dbmcp 的做法是：**不靠 prompt 让 agent 守规矩，而是让越界操作直接报错**。

```
> 把已付款但没发货的订单标记为 cancelled

READ_ONLY: 语句被拒绝 — 根动词 UPDATE 不在白名单（允许：select/show/describe/explain）
```

## 安装

```bash
# 方式一：源码构建
git clone https://github.com/longyunBegin/dbmcp.git
cd dbmcp
npm install
npm run build

# 方式二：直接跑构建产物（仓库内）
node apps/cli/dist/index.js --help
```

要求 Node.js >= 20。

## 三步接入

### 1. 绑定项目

在**你的项目目录**下执行（不会写入任何文件）：

```bash
node <path-to-dbmcp>/apps/cli/dist/index.js init
```

交互示例：

```
? 引擎 (mysql/redis): mysql
? 连接名: main
? 主机: 127.0.0.1
? 端口: 3306
? 数据库名: my_shop
? 用户名（建议使用只读账号）: ro_user
? 密码（输入不回显）: ****
? 可见 schema（逗号分隔，留空=默认库）: app
? 这是生产库吗？: No
✓ 配置已写入 ~/.dbmcp/projects/my-shop-9f3a1c/project.yaml
✓ 项目目录未写入任何文件
```

非交互用法（CI / 脚本）：

```bash
node apps/cli/dist/index.js init --non-interactive \
  --engine mysql --name main \
  --host 127.0.0.1 --port 3306 --database my_shop --user ro_user \
  --password '****' --schema app
```

Redis：

```bash
node apps/cli/dist/index.js init --non-interactive \
  --engine redis --name cache \
  --url redis://127.0.0.1:6379/0 --key-prefix 'app:*'
```

### 2. 写入 IDE 用户级配置

```bash
node apps/cli/dist/index.js install
```

自动检测并合并写入（写入前会生成 `.dbmcp.bak` 备份，`uninstall` 可还原）：

| 客户端 | 配置文件 | 顶层 key |
| --- | --- | --- |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| Claude Code | `~/.claude.json` | `mcpServers` |
| VS Code (Copilot) | `%APPDATA%/Code/User/mcp.json` | `servers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| Cline | VS Code globalStorage 下的 `cline_mcp_settings.json` | `mcpServers` |
| Trae | IDE 设置内的 MCP 面板 | 需手动粘贴 |

只打印不写入：

```bash
node apps/cli/dist/index.js install --print
```

### 3. 体检

```bash
node apps/cli/dist/index.js doctor
```

doctor 会做真正的验证，而不是只打印配置：

- 状态目录是否在项目之外
- 项目根是否存在本工具产生的文件
- git 工作区是否干净
- **用你的账号实际尝试写入，断言被拒绝**
- **慢查询是否被超时中断**
- IDE 配置是否齐全

## 工作方式

MCP 以 stdio 子进程启动时，大多数客户端的 `cwd` 就是工作区根目录。因此**一条全局配置就能自动绑定任意项目**：

```
IDE 用户级配置（全局一条 dbmcp 条目）
  └─ node <dbmcp>/apps/cli/dist/index.js serve
       ├─ 解析 cwd → git remote → 绑定标识
       ├─ 命中 ~/.dbmcp/projects/<slug>/project.yaml
       └─ 建立只读连接
```

绑定标识优先取自 `git remote origin`，所以同一个仓库在 Windows 和 macOS 上会映射到同一份配置，配置本身可以跨机器复用。

## 配置

`~/.dbmcp/projects/<slug>/project.yaml`：

```yaml
version: 1
binding:
  gitRemote: git@github.com:me/my-shop.git
  path: /Users/me/work/my-shop
defaultPolicy: read

connections:
  main:
    engine: mysql
    host: 127.0.0.1
    port: 3306
    database: my_shop
    user: ro_user
    secretRef: file:main        # 密码独立存放，不写在配置里
    ssl: false
    schemas: [app]              # 只暴露这些库
    production: false
    policy: read
    readonlySession: true

  cache:
    engine: redis
    url: redis://127.0.0.1:6379/0   # URL 中禁止携带密码
    secretRef: file:cache
    keyPrefixes: ["app:*"]
    policy: read
```

### 密码解析顺序

```
1. password 字面量（需 allowPlaintext）
2. secretRef → file:<name> / env:VAR
3. password 中的 ${VAR} → 进程环境变量
4. passwordEnv → 环境变量
5. envFile 列表
6. 项目自身的 .env / .env.local（只读消费，不写回）
```

保存密码：

```bash
node apps/cli/dist/index.js secret set main     # 输入不回显
node apps/cli/dist/index.js secret list
node apps/cli/dist/index.js secret remove main
```

> `serve` 永远不会做交互式输入。解析不到密码时，工具会返回明确提示，而不是静默卡住。

## 可用工具

| 工具 | 说明 |
| --- | --- |
| `db_list_connections` | 列出已绑定的连接与可用状态 |
| `db_list_tables` | 列出表（最多 500 条，支持 pattern） |
| `db_describe_table` | 列、类型、索引、外键、注释（敏感列默认值脱敏） |
| `db_search_columns` | 按列名/注释关键字反查表 |
| `db_query` | 只读 SQL |
| `db_explain` | EXPLAIN，不执行被分析语句 |
| `redis_scan` | 用 SCAN 遍历 key，永不使用 KEYS |
| `redis_inspect` | 按类型返回 key 内容，自动限长 |
| `redis_info` | dbsize、版本、运行时长 |

## 只读是怎么保证的

| 层 | 机制 |
| --- | --- |
| 会话 | MySQL `SET SESSION TRANSACTION READ ONLY` |
| 语句 | AST 解析取根动词白名单；拒绝多语句、`FOR UPDATE`、`INTO OUTFILE`、`INTO @var`、`EXPLAIN ANALYZE`、危险函数（`LOAD_FILE`、`SLEEP` 等）；解析失败即拒绝 |
| 资源 | `MAX_EXECUTION_TIME`（MariaDB 用 `max_statement_time`）、行数上限、字节上限、并发上限 |
| 账号 | 由你自备只读账号；`doctor` 会实际验证写操作被拒绝 |

Redis 使用白名单命令模型，默认拒绝。显式排除 `EVAL`/`FUNCTION`/`CONFIG`/`DEBUG`/`FLUSH*`/`KEYS` 等。

## 已知限制

1. 配置不随 git 同步，团队成员各执行一次 `init`（绑定标识由 git remote 派生，可手动同步 `~/.dbmcp/projects/<slug>/project.yaml`）。
2. 多根工作区或从非项目目录启动时可能解析失败，用 `dbmcp bind <dir>` 显式绑定。
3. 脱敏只覆盖策略中声明过的列。
4. MySQL 5.6 无会话只读；MariaDB 与 MySQL 的超时参数不同，`doctor` 会标注差异。
5. 未配置只读账号时，仅剩会话只读 + 语句闸门 + 资源上限三层防护。
6. 未做服务端 SQL 函数的完整白名单，仅内置危险函数黑名单。

## 跨平台

- 配置与状态统一走 `os.homedir()`，路径比较在 Windows/macOS 上大小写不敏感
- 配置文件固定使用 `\n`，避免跨端同步产生 diff
- Windows 下凭据文件用 `icacls` 收紧权限，其余平台 `chmod 600`
- Windows 上建议在 IDE 配置里写 `node` 的绝对路径，不要依赖 `npx`（`npx.cmd` 在部分客户端 spawn 会失败）

## 开发

```bash
npm install
npm run build     # tsc -b，按依赖顺序构建
npm run clean
```

结构：

```
apps/cli            命令入口：init / bind / install / secret / doctor / serve / uninstall
packages/core       配置 schema、项目绑定、密钥解析、SQL 拦截、结果序列化
packages/driver-mysql
packages/driver-redis
packages/server     MCP 工具层
```

## 路线图

- [ ] OS 凭据库后端（Windows DPAPI / macOS Keychain）
- [ ] PostgreSQL 驱动
- [ ] 单文件二进制分发与签名（Windows Authenticode / macOS 公证）
- [ ] 审计日志与列级脱敏策略
- [ ] HTTP transport（团队共享实例）

## License

MIT
