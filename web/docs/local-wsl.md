# WSL 本地构建与启动

当前工作机优先使用 **WSL 的 Linux Node.js 24+、Linux 依赖和 webpack 静态构建**。2026-10-30 已在单机版验证构建、启动、发现页、SQLite API，以及页面实际提供的 0.1 步进脚本。多人版保留相同构建方式，但账号、登录和数据隔离仍须按该版本单独验证。

## 直接使用已验证的命令

以下命令全部从仓库的 `web/` 目录执行；不要运行根目录 Excel 启动器。本机 Linux Node 路径如下，升级或换机器后先确认路径，不要替换成 Windows `node.exe`：

```sh
DIVIWISH_NODE=/home/gao/.nvm/versions/node/v24.21.0/bin/node
"$DIVIWISH_NODE" --version
```

有源码修改或尚无 `out/` 时，先构建；退出码为 0 才继续启动：

```sh
DIVIWISH_STATIC_EXPORT=1 "$DIVIWISH_NODE" node_modules/next/dist/bin/next build --webpack
```

然后启动静态页面和 SQLite API：

```sh
"$DIVIWISH_NODE" --env-file-if-exists=.env.local scripts/preview.mjs
```

访问 [http://localhost:3000/discovery](http://localhost:3000/discovery)。此方式只需一个 3000 端口的进程，不需要额外启动 8787 后端。`Ctrl+C` 停止后，用同一启动命令即可再次运行；源码没有变化时复用 `out/`，无需重新构建。

在新终端启动时需要重新设置 `DIVIWISH_NODE`。单机版沿用 `.local/standalone/diviwish.sqlite3`（或 `DIVIDEND_DATABASE` 指定文件），多人版沿用自己的 `.local/accounts/` 和账号配置；不要互换数据库，不读取或清理 `backend/data/` 的数据库、备份和快照。

## 启动前后检查

先确认 3000 是否已经被使用：

```sh
ss -ltnp 'sport = :3000'
curl -fsS http://127.0.0.1:3000/api/health
```

如已有本项目的服务，且无需更新页面，直接复用。需要更新时，先完成构建，再在原终端按 `Ctrl+C` 停止该服务后启动；不要重复运行 `dev` 占用 3000，也不要停止未确认归属的进程。可用 `readlink /proc/<PID>/cwd` 和 `readlink /proc/<PID>/exe` 确认运行目录与 Node 路径。

启动后检查：

```sh
curl -I http://127.0.0.1:3000/discovery
curl -fsS http://127.0.0.1:3000/api/health
```

单机版发现页应返回 200，健康接口应报告 `status: ok`、`database: sqlite`、`mode: standalone`。多人版需继续验证登录和账号 API。页面已在浏览器打开时，刷新以加载最新构建；健康接口正常只能说明后端可用，不能证明页面包含最新改动。

## 已遇到的环境问题

- WSL 默认 `PATH` 可能没有 `node` / `npm`，但 Linux Node 已安装；优先使用上面的已确认绝对路径。
- Windows 与 WSL 不共用安装好的原生依赖。本次 `node_modules/` 有 Linux 版 `lightningcss` 和 Tailwind Oxide；改用 Windows Node 后报缺少 `lightningcss.win32-x64-msvc.node`。保持依赖安装、构建和启动使用同一平台。
- 本次 WSL Turbopack 构建长时间停在编译阶段，尚未定位确切原因；跨 Windows 挂载盘访问可能影响性能，不能据此认定是唯一原因。改用 `--webpack` 后完成构建。当前工作机不要先尝试默认 Turbopack 再反复切换平台。
- `npm run build` 当前没有传入 `--webpack`；`npm run dev` 也不是上述验证成功的启动路径。当前 WSL 环境优先使用本文的直接命令；其他环境可按各分支 README 的通用 npm / Docker 方式运行。
- 若确需重新安装依赖，应在选定的 WSL Linux Node/npm 环境中从 `web/` 执行 `npm ci`，不要在排查时反复用 Windows npm 和 Linux npm 覆盖同一个 `node_modules/`。本次成功启动无需重装依赖。

这份记录针对本地构建与运行；不涉及线上发布或数据库迁移。
