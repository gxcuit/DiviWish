# 一键安装、构建与启动

两版网站共用同一份 `scripts/launch.mjs`，Windows 和 Linux 入口只负责找到 Node 并传入参数。前提是已安装包含 npm 的 Node.js 24+；启动器安装项目依赖，不更改系统 Node/npm。

## 日常使用

| 系统或用途 | 从 `web/` 执行 |
| --- | --- |
| Windows 一键启动 | 双击 `run.cmd`，或在终端运行 `run.cmd` |
| Linux / WSL 一键启动 | `./run.sh`，或 `sh run.sh` |
| 通用一键启动 | `npm run launch` |
| Windows 只安装和构建 | `setup.cmd` |
| Linux / WSL 只安装和构建 | `./setup.sh` |
| 通用只安装和构建 | `npm run setup` |
| 开发热更新 | `npm run dev` |
| 已有构建直接预览 | `npm start` |

第一次一键运行会检查 Node/npm，安装锁定依赖（包括构建所需的开发依赖与平台可选原生包，即使外部设置了 `NODE_ENV=production`），调用 `npm run build` 的 webpack 静态导出，然后在一个进程中提供网页和 API。默认地址为 http://localhost:3000/discovery，按 Ctrl+C 停止。单机版直接使用；多人版保留邮箱／LinuxDO 本地登录流程，首次本地配置按原有规则初始化。

脚本可从其他工作目录调用，支持项目路径含空格。Linux 脚本固定 LF 换行并设置可执行权限，Windows 脚本按 CRLF 检出；Git 配置位于 `web/.gitattributes`。

## 重复启动与更新

依赖安装结果记录在 `node_modules/.diviwish-install.json`；构建状态与进程锁位于 `.local/launcher/`。这些文件均不提交 Git。依赖锁文件、项目包配置、npm 配置或平台／Node ABI 变化时运行 `npm ci`；缓存命中时还会检查关键原生依赖是否可加载。

前端源码、公开资源、构建配置、相关环境文件、Node 版本或 `NEXT_PUBLIC_*` 环境变量变化时重新构建；导出文件缺失时也会重建。后台代码由 Node 直接运行，仍会随重新启动生效。只有成功的安装和构建才写入完成标记，失败时不启动旧页面冒充成功。

端口被占用或同一工作目录已有启动器时，脚本显示原因并退出，不终止其他进程。默认端口可用 `.env.local` 中的 `WEB_PORT=3100` 修改；多人版更换端口还应将 `.dev.vars` 的 `APP_ORIGIN` 改为对应来源。已退出进程留下的同平台锁会自动清理；跨系统或损坏的锁不能安全判断，请先确认原服务已停止，再删除 `.local/launcher/running.json`。

可选参数通过相应脚本或 npm 转交：

```sh
# 强制重新构建
npm run launch -- --rebuild
# 重新安装依赖，并重新构建
npm run launch -- --reinstall
# 只安装和构建
npm run launch -- --prepare
# 查看帮助
npm run launch -- --help
```

Windows 同样支持 `run.cmd --rebuild`、`setup.cmd --reinstall`；Linux 对应 `./run.sh --rebuild`、`./setup.sh --reinstall`。Windows 出错时保留窗口等待查看；自动化环境设置 `CI=1` 后不等待按键，保留错误退出码。

## 数据与配置

启动器不覆盖现有 `.env.local`、`.dev.vars`，不复制示例配置覆盖用户配置。单机版沿用 `.local/standalone/` 或指定的 `DIVIDEND_DATABASE`；多人版沿用独立 `.local/accounts/`。正常启动仅执行各版本原有的本地数据库初始化或迁移，保留已有记录。

`backend/data/` 的旧 SQLite、备份、初始快照和根目录 Excel 流程保持独立。启动器不会创建 Cloudflare 资源、部署网站或迁移生产数据库。Windows 与 Linux 建议使用独立工作副本；切换平台不能复用已安装的原生二进制依赖，详见[跨平台构建](build.md)。


## 2026-11-03 验证记录

| 平台 | 单机版 | 多人版 |
| --- | --- | --- |
| 原生 Windows，Node 24.18.1 | 通过 `run.cmd` / `setup.cmd` 完整启动场景 | 相同场景通过，并验证源码改变后真实重建 |
| WSL Linux 原生临时目录，Node 24.21.0 | 通过 `run.sh` / `setup.sh` 完整启动场景，并验证源码改变后真实重建 | 相同启动场景通过 |

四组都从无依赖、无构建的独立副本开始，实际执行 npm 安装及 webpack 构建，检查网页与健康 API、单机直接访问和多人私有接口需登录。随后验证重复启动拦截、停止后重新启动、缓存复用、端口占用提前停止、构建退出码保留及安装失败不启动。测试目录含空格，从其他工作目录调用脚本。现有数据库哨兵文件、`.env.local` 与多人版 `.dev.vars` 的字节保持不变；所有账号库与应用数据都在临时副本内。

额外在 Linux 验证 `NODE_ENV=production` 下安装开发依赖并完成 webpack 构建；空 `WEB_PORT` 与预览脚本保持相同默认值，端口占用时仍在安装之前停止。两版 lint、类型检查与 92／121 项业务回归通过。结果与日志保存在主工作区被忽略的 `.local/launcher-validation/`，测试用副本验证后清理。

WSL 首次安装大量依赖时，建议将独立工作副本放在 Linux 文件系统，例如 `~/projects/DiviWish`；Windows 挂载盘 `/mnt/c/` 的大量小文件操作在本机测试中明显较慢。各系统入口及安装行为相同，这个目录建议用于改善本机性能。
