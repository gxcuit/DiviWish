# DiviWish 项目记忆

更新日期：2026-10-30。本规则按用户最新要求生效，替代此前分别维护公开 / 私有仓库的安排。

## 唯一维护仓库

单机版与多人版统一维护在 https://github.com/gxcuit/DiviWish 。`gxcuit/DiviWish-private` 已停用，不再作为开发、同步或推送目标；保留旧仓库，不删除历史。

| 分支 | 版本与用途 |
| --- | --- |
| `main` | 单机版稳定分支：本地 SQLite、单人使用、无需登录注册，支持 npm / Docker |
| `codex/standalone` | 单机版开发分支 |
| `multi-user` | 多人版稳定分支：邮箱 / LinuxDO 登录、注册、会话与用户数据隔离 |
| `develop` | 多人版集成开发分支 |

## 长期执行规则

1. 开始工作前核对远程 URL、当前分支和工作区；本地 `origin` 统一指向 `gxcuit/DiviWish`。不要向停用的私有仓库推送。
2. 单机专属修改进入 `codex/standalone` / `main`；账号、登录注册、用户隔离等专属修改进入 `develop` / `multi-user`。两版沿用各自数据库、配置与运行方式。
3. 通用功能或 bug 修复必须在单机与多人对应分支分别实现、检查和同步，不得仅改一版就算完成。可以定向移植共用逻辑，但不得整分支覆盖另一版本的账号或数据库模型。
4. 通用改动交付时说明两版对应分支、提交与验证结果；受阻的一侧明确列出未完成项。
5. 只公开源码、示例配置与文档，不提交真实凭据、个人数据库、备份、快照或工作簿。多人版首次迁入采用源码快照，接在公开仓库历史上，不连接原私有仓库的历史提交。
6. 网站源码、依赖、后端、数据库配置、部署文件与详细文档统一放在 `web/`；根 README 展示功能、截图、分支区别及 LinuxDO 社区致谢。根目录 Excel 流程独立，保留 `web/backend/data/` 中的 SQLite、备份和初始快照。
7. 代码推送不等于部署线上服务；不因迁移仓库自动发布 Cloudflare、迁移生产数据库或修改线上凭据。
8. 当前工作机本地运行优先按 [WSL 构建与启动记录](web/docs/local-wsl.md)：使用 WSL Linux Node 与 Linux 依赖，显式 `--webpack` 静态构建，再运行 `scripts/preview.mjs`。先检查已有服务，源码未变时复用构建；不要混用 Windows Node 与 Linux 原生依赖，也不要先重试已停滞的默认 Turbopack。完整命令与验证范围以该文档为准。

用户最新要求：单机版和多人版都关联 `gxcuit/DiviWish`，`gxcuit/DiviWish-private` 不再使用；通用功能 / bug 修改仍须同时处理两版。
