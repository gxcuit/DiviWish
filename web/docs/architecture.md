# 单机版架构

所有网站源码、依赖、数据库配置、启动器和文档位于 `web/`。根目录 Excel 流程独立。

```text
浏览器 → Node HTTP 服务（npm start / Docker，3000）
           ├─ Next.js 导出的 out/ 静态页面
           └─ /api/stocks、/api/sectors、/api/refresh
                 → TypeScript 业务处理器 → 本地 SQLite 文件
                 → 固定的公开行情、分红、汇率、历史数据接口
```

页面直接渲染看板，没有登录、注册、密码重置、验证码、OAuth 或会话接口。数据库只有单人股票、自选标记、板块及元数据，不包含用户归属或账号表。浏览器只保留界面临时状态，业务数据不依赖 localStorage。

开发模式由 `npm run dev` 同时启动 Next.js（3000）和 Node API（8787），Next.js 将 `/api/*` 代理至 API。构建后由同一个 Node 进程提供静态页面和 API；运行时使用 Node 24 内置 SQLite，无需第三方 npm 数据库包或 Python。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/app/discovery/page.tsx` | 直接进入股息看板 |
| `src/features/dividends/` | 业务界面、同源 API 调用和类型 |
| `worker/index.ts` | API 路由，沿用历史目录名但由 Node 执行 |
| `worker/portfolio.ts`、`database.ts` | 单人股票、板块及元数据持久化 |
| `worker/calculations.ts`、`render.ts`、`validation.ts` | 计算、展示和输入校验 |
| `worker/refresh.ts` | 全局和单股刷新、并发修改保护 |
| `worker/providers.ts`、`dividends.ts`、`history.ts`、`bollinger.ts` | 公开行情、分红、历史分位、BOLL |
| `scripts/local-server.mjs` | HTTP、静态页面、Host 校验 |
| `scripts/local-database.mjs` | SQLite WAL、事务和自动迁移 |
| `scripts/runtime-config.mjs` | 默认路径及 `DIVIDEND_DATABASE` 解析 |
| `migrations/0001_initial.sql` | `stocks`、`sectors`、`metadata`；另有迁移记录表 |
| `Dockerfile`、`compose.yaml` | 静态构建、非 root 运行和数据库持久卷 |

## 数据与并发

默认数据库为 `.local/standalone/diviwish.sqlite3`，容器内为 `/data/diviwish.sqlite3`。首次启动为空，不加载原 Excel 快照或账号数据。迁移自动执行且有事务保护；检测到账号数据库时拒绝启动。原 `backend/data/`、`.local/accounts/` 和 `.wrangler/state/` 不参与默认运行。

全局刷新和 `POST /api/stocks/:id/refresh` 共用处理器，查询报价、年度/滚动股息及汇率，保存财年、明细及来源。上游查询有时间和并发限制，单项失败保留旧值。提交时比较原始文档，保留查询期间的手动修改；只有成功写入的股票能推进刷新时间与行情日期。

历史分位通过 `POST /api/stocks/:id/history` 独立更新，使用真实不复权日线与公告后下一交易日生效的完整年度股息，排除当日未完成日线。看板加载后自动补齐历史，同时处理两支；同日成功快照复用。证券身份或年度股息变化会清除对应历史；至少需要 60 个有效样本。失败时保留原快照并显示原因。

SQL 批量操作在本地同步事务中完成；编辑使用原始文档比较避免旧请求覆盖新内容。单机部署运行一个服务实例，不横向扩容。

## 访问和部署

默认仅绑定本机。无鉴权模式下所有可达访问者共用同一份数据。HTTP 服务拒绝未配置的非本机 Host；写入要求 JSON、检查 Origin 和跨站请求来源。可信局域网或反向代理地址通过 `APP_ORIGIN` 显式指定。

Docker 构建上下文采用源码白名单，运行镜像不包含个人数据或秘密。数据库目录挂载到持久卷，容器以 `node` 用户运行。备份与恢复先停止服务。部署命令、环境变量和备份步骤见 [README](../README.md)。
