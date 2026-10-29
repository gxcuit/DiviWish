<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

当前工作机的 WSL 本地构建与启动优先遵循 [已验证的 WSL 流程](docs/local-wsl.md)：Linux Node / Linux 依赖、显式 `--webpack` 静态构建、`scripts/preview.mjs` 启动。先检查已有服务；源码未变时复用构建。下方 npm / Windows / Docker 命令为其他环境的通用入口。

# DiviWish 网站

本目录是 DiviWish 的 Web 应用；后续股息率网站改动都在这里进行。

- Next.js 16 / React 19 / TypeScript 严格模式；当前为 Cloudflare Worker + D1 邮箱密码账号版（注册/重置需要邮箱验证码）。本地 Node.js 24 使用同一 Worker 处理器与 SQLite D1 适配。
- `src/app/` 为路由，`src/features/dividends/` 为股息业务（`components/`、`api.ts`、`types.ts`），`src/components/ui/` 为通用界面组件，`src/lib/` 为公共工具。
- `worker/index.ts` 是当前后端入口；`src/features/auth/` 是账号界面。`worker/legacy.ts` 和 `backend/` 保留旧单人实现。`docs/` 保存网站文档。
- 保留 backend/data/ 的 SQLite、备份和 seed 以及 .wrangler/state/；本地账号库只使用 .local/accounts/，检查与测试只使用临时数据库。
- 在本目录运行 `npm run dev` 同时启动前后端；Windows 也可运行 `run.cmd`。
- 检查：`npm run check`；后端测试：`npm test`；本地 HTTP 检查：`npm run test:runtime`。不要用测试库覆盖个人数据。
- 密钥只放被忽略的 .dev.vars；临时 Resend Full access 密钥只放 .local/resend-setup.env，不提供给应用。
- 用户已授权部署账号版到现有 Cloudflare Worker `diviwish`；生产操作明确使用 `--env production`，账号库独立于原 `diviwish` D1。dry-run 仅打包。所有私人数据访问必须从会话获取 user_id 并在 SQL 中过滤。
- 使用 2 空格缩进、具名导出、严格类型，延续现有样式及计算口径。
- 上级目录的 Excel 脚本与工作簿独立维护；首次快照导入使用 `--source ..`，不得覆盖现有数据库或自动运行上级更新脚本。

- 版本归属及双端同步规则见 [项目记忆](../MEMORY.md)：唯一仓库为 `gxcuit/DiviWish`；单机版用 `main` / `codex/standalone`，多人版用 `multi-user` / `develop`；通用功能与 bug 修复两版同步，停用原私有仓库。
