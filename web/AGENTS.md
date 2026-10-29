<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# DiviWish 网站（单机版）

本分支 `codex/standalone` 为个人本地使用版本；网站所有改动在本目录进行。

- Next.js 16 / React 19 / TypeScript 严格模式，Node.js 24+ 内置 SQLite，无登录、注册或账号接口。
- `src/app/` 是页面路由，`src/features/dividends/` 是业务界面，`worker/` 保留历史目录名并由本地 Node 执行。`backend/` 保留 Flask 历史实现。
- 默认数据库只使用 `.local/standalone/diviwish.sqlite3`，可通过 `DIVIDEND_DATABASE` 指定独立文件；不得自动读取或覆盖 `.local/accounts/`、`backend/data/` 或 `.wrangler/state/`。
- 保留 `backend/data/` 的 SQLite、备份和初始快照；测试只使用内存或临时数据库。
- 从本目录运行 `npm run dev`；构建运行用 `npm run build`、`npm start`。Windows 可用 `run.cmd`。Docker 用 `docker compose up -d --build`。
- 检查：`npm run check`；部署与配置说明见 `README.md`。Docker 数据目录必须挂载持久卷。
- 单机版无访问账号，默认仅监听本机，不执行线上发布。可信局域网或反向代理访问需显式配置 `APP_ORIGIN`。
- 使用 2 空格缩进、具名导出、严格类型，延续现有样式与计算口径。
- 根目录 Excel 脚本和工作簿独立维护，不自动运行或导入。

- 版本归属及双端同步规则见 [项目记忆](../MEMORY.md)：唯一仓库为 `gxcuit/DiviWish`；单机版用 `main` / `codex/standalone`，多人版用 `multi-user` / `develop`；通用功能与 bug 修复两版同步，停用原私有仓库。
