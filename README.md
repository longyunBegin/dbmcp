# dbmcp

让 **Cursor / Trae / Claude Code / VS Code** 里的 AI 助手能「只读」地查你的 MySQL 和 Redis，
而且**不在你的项目目录里留下任何文件**。

> 一句话：配置放在家目录，凭据单独存，写操作在到达数据库之前就被拦掉。

---

## 目录

- [它解决什么问题](#它解决什么问题)
- [核心特性](#核心特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始（5 分钟）](#快速开始5-分钟)
- [连接多个库 / 多个账号 / 多个环境](#连接多个库--多个账号--多个环境)
- [命令一览](#命令一览)
- [配置文件说明](#配置文件说明)
- [给 AI 的 9 个工具](#给-ai-的-9-个工具)
- [只读是怎么保证的](#只读是怎么保证的)
- [常见问题](#常见问题)
- [跨平台说明](#跨平台说明)
- [已知限制](#已知限制)
- [开发](#开发)

---

## 它解决什么问题

想让 AI 帮你查数据库，通常只有两个办法：把账号密码贴进对话框，或者给它一个能连库的工具。
两种都很危险——AI 可能改数据，也可能把整张表的结果塞进上下文。

dbmcp 的做法是把「能力」和「权限」分开：

- AI 能做的：看表结构、查数据、看执行计划
- AI 不能做的：INSERT / UPDATE / DELETE / DDL / 多语句 / `FOR UPDATE` / `INTO OUTFILE`

越界不会靠提示词劝阻，而是**直接报错**：

```
ERROR: 根动词 UPDATE 不在白名单（允许: select/show/describe/explain）
```

---

## 核心特性

| 特性 | 说明 |
| --- | --- |
| 项目零写入 | 配置、密码、日志全在 `~/.dbmcp/`，仓库里一个文件都不会多 |
| 数据库零改动 | 不需要建账号、改结构、写数据，用你自备的账号 |
| 三层只读 | 会话只读事务 + SQL 语句白名单 + 资源上限 |
| 多账号多环境 | 一个项目可挂多个连接，每个连接有独立账号、密码、环境和可见库 |
| 密码分离 | 配置文件里只有引用，真实密码单独存并收紧权限 |
| 体检可验证 | `doctor` 会真的连库、真的检查权限，而不是只打印配置 |
| 跨平台 | Windows / macOS / Linux，路径与换行都做了处理 |

---

## 环境要求

- Node.js **>= 20**
- MySQL 5.7+ / 8.x，或 MariaDB 10.x+
- Redis 5+（只读体检用到的 `ACL DRYRUN` 需要 Redis 7+，低版本会降级提示）
- 建议准备一个**只读账号**：`GRANT SELECT, SHOW VIEW ON your_db.* TO 'user'@'%'`

---

## 安装

```bash
git clone https://github.com/longyunBegin/dbmcp.git
cd dbmcp
npm install
npm run build
```

可选：跑一遍离线自检（不需要任何数据库，20 项检查）

```bash
npm run smoke
```

输出：

```
[1] init 绑定项目            4 PASS
[2] SQL 只读拦截             8 PASS
[3] doctor 隔离检查          3 PASS
[4] MCP 协议                 4 PASS
20 PASS / 0 FAIL
```

### 加一个命令别名（推荐）

Windows PowerShell，把下面这行加到 `$PROFILE`：

```powershell
function dbmcp { node "C:\path\to\dbmcp\apps\cli\dist\index.js" @args }
```

macOS / Linux，加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
alias dbmcp='node /path/to/dbmcp/apps/cli/dist/index.js'
```

之后的命令都可以简写成 `dbmcp xxx`。

---

## 快速开始（5 分钟）

### 第 1 步：绑定项目

进入**你的项目目录**执行：

```powershell
cd C:\your\project
dbmcp init
```

按提示填写：

```
? 引擎 (mysql/redis): mysql
? 连接名: main
? 主机: 127.0.0.1
? 端口: 3306
? 数据库名: my_shop
? 用户名（建议使用只读账号）: ro_user
? 可见 schema（逗号分隔，留空=默认库）: my_shop
? 这是生产库吗？: No
? 环境标识 (dev/test/uat/prod): dev
? 密码（输入不回显）: ****

✓ 配置已写入 ~/.dbmcp/projects/my-shop-9f3a1c/project.yaml
✓ 密码已保存到 ~/.dbmcp/secrets/my-shop-9f3a1c.json（权限已收紧）
  项目目录不会写入任何文件
```

> **重要**：`init` 只在 `~/.dbmcp/` 下写文件，你的项目目录不会有任何变化。
> 绑定标识优先取自 `git remote`，所以同一个仓库换台机器重新 `init` 会落到同一份配置。

非交互用法（脚本 / CI）：

```powershell
dbmcp init --non-interactive --engine mysql --name main `
  --host 127.0.0.1 --port 3306 --database my_shop `
  --user ro_user --password '****' --schema my_shop --env dev
```

### 第 2 步：录入密码（如果上一步跳过了）

```powershell
dbmcp secret set main
```

输入时不回显。密码保存在 `~/.dbmcp/secrets/<项目>.json`，Windows 上用 `icacls` 收紧权限，
其他平台 `chmod 600`。

### 第 3 步：体检

```powershell
dbmcp doctor
```

```
dbmcp doctor
  项目    C:\your\project
  绑定    my-shop-9f3a1c

  检查项        结果    说明
  配置外置       PASS   状态全部位于 ~/.dbmcp
  项目零文件     PASS   项目根无 dbmcp 文件
  git 工作区     PASS   干净
  main 连接      PASS   [dev] my_shop @ 127.0.0.1:3306
  main 只读      PASS   仅只读权限（依据 SHOW GRANTS）
  main 超时      PASS   慢查询在 5004ms 被中断
  IDE 配置       WARN   尚未运行 dbmcp install

  5 PASS / 1 WARN / 0 FAIL
```

重点看 `只读` 这一行：

- `PASS` → 账号本身就只能读，防护最完整
- `WARN 账号具备写权限` → 账号能写，目前只靠工具层的会话只读和语句白名单拦

体检**不会写任何数据**：MySQL 只看 `SHOW GRANTS`，Redis 只用 `ACL DRYRUN` 判断权限。

### 第 4 步：接入 IDE

```powershell
dbmcp install
```

它会自动检测并**合并**写入这些用户级配置（写前生成 `.dbmcp.bak` 备份）：

| 客户端 | 配置文件 |
| --- | --- |
| Cursor | `~/.cursor/mcp.json` |
| Claude Code | `~/.claude.json` |
| VS Code (Copilot) | `%APPDATA%/Code/User/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Cline | VS Code globalStorage 下的 `cline_mcp_settings.json` |
| Trae | 需要在 IDE 的 MCP 面板手动粘贴（命令会打印片段） |

只想看要粘贴什么、不写文件：

```powershell
dbmcp install --print
```

如果 IDE 启动 MCP 时的工作目录不是你的项目（Trae 常见），需要手动指定 `--dir`：

```json
{
  "mcpServers": {
    "dbmcp": {
      "command": "node",
      "args": [
        "C:\\path\\to\\dbmcp\\apps\\cli\\dist\\index.js",
        "serve",
        "--dir",
        "C:\\your\\project"
      ]
    }
  }
}
```

### 第 5 步：让 AI 用起来

重启 IDE（或新开一个会话），然后直接提问：

> 列出当前项目的数据库连接

> orders 表有哪些字段？

> 最近 7 天各状态有多少订单？

想验证拦截是否生效，可以故意让它改数据：

> 把已付款的订单标记为 cancelled

预期回答：

```
ERROR: 根动词 UPDATE 不在白名单（允许: select/show/describe/explain）
```

---

## 连接多个库 / 多个账号 / 多个环境

同一个项目可以挂任意多个连接，每个连接有独立的账号、密码、环境和可见库。

### 用命令追加

```powershell
# 第二个账号
dbmcp init --non-interactive --name operate --engine mysql `
  --host db.example.com --database haipay_operate `
  --user operate_ro --schema haipay_operate --env dev

# 测试环境
dbmcp init --non-interactive --name portal-test --engine mysql `
  --host test-db.example.com --database haipay_portal `
  --user portal_ro --schema haipay_portal --env test

# 各自录入密码
dbmcp secret set operate
dbmcp secret set portal-test
```

`init` 是**追加**语义，不会覆盖已有的其他连接。

### 查看分组

```powershell
dbmcp list
```

```
[dev]
  连接名   引擎   目标              默认库          可见库                     密码
  main     mysql  db.example.com    haipay_portal   haipay_portal, haipay_data 已保存
  operate  mysql  db.example.com    haipay_operate  haipay_operate             已保存

[test]
  连接名       引擎   目标                   默认库          可见库           密码
  portal-test  mysql  test-db.example.com    haipay_portal   haipay_portal   已保存
```

只看某个环境：

```powershell
dbmcp list --env test
```

### 对应的配置文件

`~/.dbmcp/projects/<绑定标识>/project.yaml`：

```yaml
version: 1
binding:
  gitRemote: git@github.com:me/my-shop.git
  path: /Users/me/work/my-shop
defaultPolicy: read

connections:
  portal-dev:
    engine: mysql
    host: db.example.com
    port: 3306
    database: my_shop
    user: portal_ro
    secretRef: file:portal-dev      # 密码不在这里
    schemas: [my_shop, my_shop_data]
    environment: dev
    production: false
    policy: read

  portal-test:
    engine: mysql
    host: test-db.example.com
    port: 3306
    database: my_shop
    user: portal_ro
    secretRef: file:portal-test
    schemas: [my_shop]
    environment: test
    production: false

  cache:
    engine: redis
    url: redis://redis.example.com:6379/0
    secretRef: file:cache
    keyPrefixes: ["app:*"]
    environment: dev
    policy: read
```

改了配置之后可以随时用 `dbmcp edit` 打开它。

---

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `dbmcp init` | 绑定当前项目 / 追加一个连接（只写 `~/.dbmcp`） |
| `dbmcp bind <dir>` | 显式绑定某个目录，等价于 `init --dir` |
| `dbmcp list [--env dev]` | 按环境分组列出所有连接 |
| `dbmcp edit` | 用 `$EDITOR` 打开配置文件 |
| `dbmcp secret set <连接名>` | 录入 / 轮换密码（不回显） |
| `dbmcp secret list` | 查看已保存密码的连接 |
| `dbmcp secret remove <连接名>` | 删除某个连接的密码 |
| `dbmcp doctor` | 体检：零写入、只读是否生效、超时是否生效 |
| `dbmcp query "<SQL>"` | 命令行执行一条只读 SQL（同样过语句闸门） |
| `dbmcp install [--client ...]` | 写入 IDE 用户级 MCP 配置 |
| `dbmcp status` | 查看已安装的 IDE 客户端 |
| `dbmcp uninstall` | 从 IDE 配置里移除 dbmcp 条目 |
| `dbmcp serve` | 以 stdio 启动 MCP 服务（由 IDE 调用） |

常用参数：

```powershell
dbmcp doctor --connection main      # 只体检某个连接
dbmcp doctor --allow-prod           # 允许体检标记为生产库的连接
dbmcp query "select 1" -c main      # 指定连接执行
dbmcp query "select 1" --max-rows 50
dbmcp install --client cursor,claude
dbmcp install --print
```

---

## 配置文件说明

### 连接字段

| 字段 | 说明 |
| --- | --- |
| `engine` | `mysql` 或 `redis` |
| `host` / `port` | MySQL 或 Redis 地址；Redis 也可以直接用 `url` |
| `database` | MySQL 默认库；Redis 用 URL 里的 `/0` 指定 db |
| `user` | 数据库账号 |
| `url` | Redis 用，例如 `redis://host:6379/0`。**URL 里不允许带密码** |
| `secretRef` | 密码引用，`file:<名称>` 或 `env:变量名` |
| `password` | 直接写密码（不推荐），或写 `${ENV_VAR}` |
| `passwordEnv` | 用哪个环境变量取密码 |
| `envFile` | 读取哪些 dotenv 文件取密码（只读，不会写回） |
| `ssl` | `true` 或 TLS 参数对象；Redis 也可以用 `rediss://` |
| `schemas` | MySQL 可见库白名单，用于 `db_list_tables` 等 |
| `keyPrefixes` | Redis key 前缀白名单，用于限制可见范围 |
| `environment` | `dev` / `test` / `uat` / `prod`，仅用于标识与展示 |
| `production` | `true` 时默认拒绝访问，需要 `--allow-prod` 才放行 |
| `policy` | 引用的策略名，默认 `read` |
| `readonlySession` | 是否在连接后设置 `SET SESSION TRANSACTION READ ONLY`，默认 `true` |

### 密码解析顺序

```
1. password 字面量（需要 allowPlaintext: true）
2. secretRef → file:<名称> 或 env:<变量>
3. password 里的 ${VAR} → 进程环境变量
4. passwordEnv → 进程环境变量
5. envFile 列表里的文件
6. 项目自身的 .env / .env.local（只读读取，不修改）
```

> `serve` 永远不会弹交互输入。解析不到密码时，工具会返回明确提示，
> 例如 `缺少密码，执行 dbmcp secret set main`。

### 自定义策略

不写 `policies` 时使用内置的 `read` 策略：

```yaml
defaultPolicy: read

policies:
  read:
    mysql:
      allow: [select, show, describe, explain]
      denyFunctions: [load_file, sleep, benchmark, get_lock]
    redis:
      allow: [get, hgetall, lrange, scan, type, ttl, ...]
      deny: [eval, function, config, debug, flushall, keys, set, del, ...]
    limits:
      maxRows: 200
      maxBytes: 262144
      timeoutMs: 5000
      maxConcurrent: 2
    redact:
      mysqlColumns: ["*.password_hash", "*.phone", "*.id_card"]
      redisKeyPatterns: ["session:*", "auth:*"]
```

---

## 给 AI 的 9 个工具

| 工具 | 作用 |
| --- | --- |
| `db_list_connections` | 列出连接、环境、可见库、密码状态 |
| `db_list_tables` | 列出表（最多 500 条，支持 `pattern` 过滤） |
| `db_describe_table` | 列、类型、索引、外键、注释 |
| `db_search_columns` | 按列名 / 注释关键字反查表，了解陌生 schema 最省 token |
| `db_query` | 只读 SQL |
| `db_explain` | EXPLAIN（不会执行被分析的语句） |
| `redis_scan` | 用 `SCAN` 遍历 key，永不使用 `KEYS` |
| `redis_inspect` | 按类型返回 key 内容，自动限长 |
| `redis_info` | dbsize、版本、运行时长 |

多个连接时，AI 需要指定 `connection`；只有一个连接时可以省略。
如果配了多个又没指定，工具会报错并列出可选项，**不会默认猜一个**。

---

## 只读是怎么保证的

| 层 | 机制 | 能挡住什么 |
| --- | --- | --- |
| 会话 | `SET SESSION TRANSACTION READ ONLY` | 漏过闸门的写语句 |
| 语句 | AST 解析 + 根动词白名单 | 多语句、`FOR UPDATE`、`INTO OUTFILE`、`INTO @var`、`EXPLAIN ANALYZE`、危险函数 |
| 资源 | `MAX_EXECUTION_TIME`、行数 / 字节 / 并发上限 | 慢查询、一次查出几十万行把上下文打爆 |
| 账号 | 你自备的只读账号（可选） | 前三层都失效时的最后一道墙 |

Redis 侧使用**白名单命令**模型，默认拒绝。显式排除
`EVAL / FUNCTION / SCRIPT / CONFIG / DEBUG / MODULE / CLIENT / MONITOR / FLUSH* / KEYS / SET / DEL` 等。

`dbmcp doctor` 会用**零写入**的方式验证这些是否真的生效：

- MySQL：`SHOW GRANTS FOR CURRENT_USER()` 判断有没有写权限
- Redis：`ACL WHOAMI` + `ACL DRYRUN SET` 判断 SET 是否被允许
- 两边都会跑一条 `SELECT SLEEP(30)`，确认慢查询会在 5 秒被中断

---

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Server does not support secure connection` | 服务端没开 SSL，但配置里写了 `ssl: true` | 把 `ssl` 改成 `false`，或让 DBA 开启 SSL |
| `Access denied for user 'x'@'1.2.3.4' (using password: YES)` | 密码错，或账号限制了来源 IP | 重新 `dbmcp secret set <名称>`；仍失败则查账号的允许来源 |
| `Host 'x' is not allowed to connect` | 账号没有匹配的来源授权 | 让 DBA 给当前出口 IP 授权 |
| `当前目录未绑定 dbmcp` | 启动 MCP 时的工作目录不是项目目录 | 在 `serve` 参数里加 `--dir C:\your\project` |
| IDE 里 MCP 启动失败、没有报错 | Windows 上 `npx.cmd` 在子进程中常启动不了 | 配置里用 `node` 的绝对路径，不要用 `npx` |
| `self signed certificate` | 服务端证书不被 Node 默认信任 | 配置里指定 CA，或临时关闭校验（不推荐） |
| `SLEEP 未被中断` | 网络抖动导致客户端 20 秒内没收到中断 | 重跑 `doctor`；持续出现则检查账号是否限制了资源 |
| `该连接已存在` | `init` 时连接名重复 | 换一个连接名，或用 `dbmcp edit` 修改 |

调试小技巧：

```powershell
dbmcp doctor --connection main     # 只查一个连接，输出更聚焦
dbmcp query "select 1" -c main     # 最小连通性验证
dbmcp list                         # 先确认连接名和环境
```

---

## 跨平台说明

- 状态目录统一走 `os.homedir()`，路径比较在 Windows / macOS 上大小写不敏感
- 配置文件固定使用 `\n` 换行，避免双端同步产生无意义 diff
- Windows 用 `icacls` 收紧密码文件权限，其他平台 `chmod 600`
- Windows 上建议在 IDE 配置里写 `node` 的绝对路径
- 绑定标识优先取 `git remote`，所以同一仓库在 Windows 和 macOS 上对应同一份配置
- 项目不是 git 仓库时，退化为按目录路径绑定

---

## 已知限制

1. 配置不进 git，团队成员各自执行一次 `init`（导出配置可手动提交，由使用者自行决定）
2. Redis 只支持单节点 / 主从的 URL 形式，暂不支持 Cluster、Sentinel
3. 多根工作区或从非项目目录启动时需要显式 `--dir`
4. 列脱敏只覆盖策略里声明过的列
5. MySQL 5.6 无会话只读；MariaDB 与 MySQL 的超时参数不同，`doctor` 会标注差异
6. `schemas` 是展示层的白名单，SQL 里用全限定名访问其他库时仍需依赖数据库账号权限
7. 未做 SQL 函数完整白名单，仅内置危险函数黑名单

---

## 开发

```bash
npm install
npm run build      # tsc -b，按依赖顺序构建
npm run smoke      # 20 项离线自检
npm run clean
```

结构：

```
apps/cli            命令入口：init / bind / list / edit / secret / doctor / query / install / serve
packages/core       配置 schema、项目绑定、密码解析、SQL 拦截、结果序列化
packages/driver-mysql
packages/driver-redis
packages/server     MCP 工具层
scripts/smoke.mjs   无需数据库的回归测试
```

---

## License

MIT
