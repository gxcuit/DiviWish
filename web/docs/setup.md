# 安装、配置与运行（本地使用）

本页集中说明安装、配置、部署、备份与检查命令。所有网站命令均从 `web/` 运行。功能介绍见[项目首页](../../README.md)，版本维护约定见[分支说明](branches.md)。

当前工作机在 WSL 中优先遵循[已验证的 Linux Node 与 webpack 流程](local-wsl.md)，不要混用 Windows 与 Linux 原生依赖。

## npm 安装与使用

安装 Node.js 24+（包含 npm），然后从仓库根目录进入网站目录：

```sh
cd web
npm ci
npm run build
npm start
```

打开 [http://localhost:3000/discovery](http://localhost:3000/discovery)。`npm start` 由一个 Node 进程同时提供静态页面和 SQLite API，默认仅监听本机 `127.0.0.1:3000`。按 `Ctrl+C` 停止，再次运行 `npm start` 会读取原数据库。修改网站源码后重新执行 `npm run build`。

开发时使用：

```sh
npm run dev
```

开发模式同时启动 Next.js（3000）和 Node API（8787），支持页面热更新。开发与构建后运行使用同一单机数据库。Windows 可先双击 `web/setup.cmd` 安装，再双击 `web/run.cmd` 启动开发模式。

首次运行自动创建 `.local/standalone/diviwish.sqlite3`，默认包含招商银行（600036）与红利ETF华泰柏瑞（510880），并提供“未分类”“银行”“ETF”板块；默认标的不预填行情和分红。在“发现”中添加股票，输入代码或名称，获取价格与股息并核对后保存；点击星标加入自选。点击股票可查看详情、调整股息率口径和网格；“我的”可管理数据及刷新行情。关闭或更换浏览器不会丢失已保存数据。

实时搜索、价格、分红、汇率和历史数据查询需要联网。网络失败时保留已存数据，仍可查看或手动维护；本地数据库不等于离线行情服务。

### 配置（可选）

无需配置即可启动。需要修改时，将 `.env.example` 复制为 `web/.env.local`；npm 启动命令自动加载该文件。实际环境变量优先，修改后重启。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `DIVIDEND_DATABASE` | `.local/standalone/diviwish.sqlite3` | SQLite 文件路径；相对路径从 `web/` 解析 |
| `WEB_PORT` | `3000` | 网页端口，开发和构建后运行均可用 |
| `API_PORT` | `8787` | 开发模式的后端端口；`npm start` 不使用此端口 |
| `HOST` | `127.0.0.1` | `npm start` 的监听地址；开发服务固定仅监听本机 |
| `APP_ORIGIN` | 自动使用本机请求来源 | 指定局域网或反向代理实际访问来源，如 `http://192.168.1.10:3000`，不带路径或末尾斜杠 |

例如换端口时，在 `.env.local` 写入 `WEB_PORT=3100`，再运行 `npm start`，访问 [http://localhost:3100/discovery](http://localhost:3100/discovery)。只运行后端可用 `npm run backend`。

## Docker Compose 部署

安装 Docker Engine / Docker Desktop 及 Compose，然后在 `web/` 运行：

```sh
docker compose up -d --build
```

打开 [http://localhost:3000/discovery](http://localhost:3000/discovery)。Compose 默认只将端口发布到宿主机回环地址，并将 `/data` 挂载到命名卷 `diviwish-data`（实际卷名带 Compose 项目前缀）。容器内数据库为 `/data/diviwish.sqlite3`；重启、重建镜像和重新创建容器会保留数据。

```sh
docker compose logs -f          # 查看日志，Ctrl+C 退出日志
docker compose stop             # 停止
docker compose start            # 再次启动
docker compose down             # 删除容器，保留数据库卷
```

更新源码后执行 `docker compose up -d --build`。不要添加 `down -v`，该选项会删除数据库卷。修改宿主机端口时，将 `compose.yaml` 中的映射改为 `127.0.0.1:3100:3000` 即可，容器内端口仍为 3000。

## 直接使用 Dockerfile

不使用 Compose 时，也可在 `web/` 执行：

```sh
docker build -t diviwish:standalone .
docker run -d --name diviwish --restart unless-stopped -p 127.0.0.1:3000:3000 -v diviwish-data:/data diviwish:standalone
```

查看日志：`docker logs -f diviwish`；停止/启动：`docker stop diviwish` / `docker start diviwish`。更新时重新构建镜像，停止并删除旧容器，然后用上面同一条 `docker run` 命令重新创建，沿用同一个数据卷。Compose 和直接运行 Docker 二选一，不要让两个进程同时使用同一个数据库。

Dockerfile 使用多阶段构建，运行镜像只包含 Node、静态页面和 API 源码，不需要 npm 运行时依赖。应用以非 root 的 `node` 用户运行，提供 `/api/health` 健康检查。`.dockerignore` 使用白名单，个人数据库、快照、工作簿、密钥和 `.env.local` 均不会发送到镜像构建上下文。

容器不读取宿主机的 `.env.local`；在 Compose 的 `environment` 中设置变量，或在 `docker run` 中使用 `-e`。如果将数据库改为其他路径，也要挂载对应目录。使用宿主目录绑定挂载时，目录必须允许容器的 UID/GID 1000 写入；默认命名卷无需手工处理权限。

## 数据备份与恢复

先停止应用再复制 SQLite 文件，避免漏掉尚在 WAL 中的写入。

- npm：停止应用，复制 `.local/standalone/diviwish.sqlite3`（或 `DIVIDEND_DATABASE` 指定的文件）到备份目录。恢复时，在应用停止期间将备份复制回同一路径，再启动。
- Compose：在 `web/` 执行下面的命令，将备份保存在宿主机：

```sh
docker compose stop
docker compose cp diviwish:/data/diviwish.sqlite3 ./diviwish-backup.sqlite3
docker compose start
```

恢复前确认当前数据也已另存备份，然后：

```sh
docker compose stop
docker compose cp ./diviwish-backup.sqlite3 diviwish:/data/diviwish.sqlite3
docker compose run --rm --no-deps --user root --entrypoint chown diviwish node:node /data/diviwish.sqlite3
docker compose start
```

恢复命令中的 `chown` 让复制回来的数据库归应用用户所有，避免恢复后无法写入。

直接运行 Docker 时对应使用 `docker stop diviwish`、`docker cp diviwish:/data/diviwish.sqlite3 ./diviwish-backup.sqlite3`、`docker start diviwish`。数据文件及 SQLite 的 `-wal` / `-shm` 文件应保存在同一个持久化目录；不要在应用运行时单独替换数据库。

原 `backend/data/` 中的 SQLite、备份和初始快照，以及 `.local/accounts/`、`.wrangler/state/` 均保留。单机启动器不会自动读取、转换或覆盖它们。账号版数据库不能直接作为单机库；误将 `DIVIDEND_DATABASE` 指向含账号表的文件时，启动会拒绝修改。此分支不提供账号数据自动合并或迁移。

## 访问范围

单机版没有访问账号或密码，能够访问服务的人可以修改全部数据。默认 npm 和 Docker 配置仅供本机使用。

如需在可信局域网从自己的其他设备访问：npm 设置 `HOST=0.0.0.0`，同时设置 `APP_ORIGIN=http://宿主机局域网IP:3000`；Docker 则将端口映射改为 `3000:3000`，并通过容器环境变量设置同一 `APP_ORIGIN`。使用反向代理时，配置 `APP_ORIGIN` 为完整访问来源并保留原始 Host。不要将无鉴权服务直接暴露到公网。

## 检查与目录

```sh
npm run check
```

包括 lint、前后端类型检查、业务回归、静态页面构建和真实 HTTP/SQLite 持久化测试。测试只使用内存或临时目录，不写入个人数据库。Docker 构建需另外执行 `docker compose build`。

| 位置 | 用途 |
| --- | --- |
| `src/features/dividends/` | 股息看板、股票管理、自选、板块、网格及日历 |
| `worker/` | Node 执行的 TypeScript API、计算和公开行情查询；沿用历史目录名 |
| `scripts/local-server.mjs` | 同源静态页面与 API 服务 |
| `scripts/local-database.mjs` | Node 内置 SQLite、迁移、事务和预编译 SQL |
| `migrations/0001_initial.sql` | 单人股票、板块和元数据表 |
| `.local/standalone/` | 默认单机持久化目录，不提交 Git |
| `Dockerfile`、`compose.yaml` | Docker 构建与持久化运行配置 |
| `backend/` | 保留的 Flask 历史实现和原个人数据，不用于默认启动 |

更多说明：[单机架构](architecture.md)、[股息计算](calculations.md)、[分支约定](branches.md)。命令背景可参考 [npm ci](https://docs.npmjs.com/cli/v11/commands/npm-ci/)、[Node SQLite](https://nodejs.org/api/sqlite.html) 和 [Dockerfile](https://docs.docker.com/reference/dockerfile/) 官方文档。

### 年内涨跌与股息支付率（2026-11-01）

个股详情增加年度股息支付率及财年、币种与每股估算口径说明。刷新行情与股息会自动补齐上年末交易日价格基准，修复新增股票年内涨跌一直显示“—”的问题；基准日期与复权方式随数值显示。缺失数据及非正收益会给出原因，详见 [计算口径](calculations.md#年内涨跌与股息支付率)。

新用户默认观察招商银行（600036）与红利ETF华泰柏瑞（510880），分类包含“ETF”。仅新账号创建或全新单机库首次初始化时添加；已有列表不补入默认标的，用户删除后不重建。默认记录不预填行情或派息金额，可点击刷新获取。
