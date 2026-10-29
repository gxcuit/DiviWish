# 网站架构与目录约定

所有网站源码、依赖、启动器和文档均位于 `web/`，根目录的 Excel 流程独立。

## 当前账号版

```text
Next.js 静态页面 → /api/auth/* → 邮箱验证码、密码注册登录、会话
               → /api/stocks、/api/sectors、/api/refresh
                    → 验证会话 → 按 user_id 访问 D1 个人数据
                    → 固定的公开行情接口
```

浏览器不保存业务数据或认证 token 到 localStorage。会话使用 HttpOnly Cookie；前端只有拿到有效用户后才渲染业务界面，服务端独立检查每次私人数据访问。

开发模式：Next.js（3000）代理 API 到本地 Node 服务（8787）。`npm start` 将导出的静态页面和 API 一起在本机提供。Node 执行同一 `worker/index.ts` 请求处理逻辑，由 `scripts/local-d1.mjs` 以真实 SQLite 实现 prepared statement 和原子 batch。

Cloudflare 生产环境使用 Workers Static Assets + Worker API + 原生 D1，主域名为 `diviwish.shaunko.tech`，`diviwish.jackgao-china.workers.dev` 保留。`wrangler.jsonc` 默认环境保留本地占位数据库，`env.production` 显式绑定独立的 `diviwish-accounts-production`；原单人线上 D1 保留。生产操作统一使用 `--env production`，详见 [Cloudflare 部署](cloudflare-deployment.md)。

## 模块

| 模块 | 职责 |
| --- | --- |
| `src/features/auth/` | 邮箱验证码界面、Turnstile 组件、会话检查 |
| `src/features/dividends/api.ts` | 同源请求，401 时返回登录页 |
| `worker/auth.ts` | 随机验证码、用途绑定、密码注册登录、频率限制、会话、退出 |
| `worker/mail.ts` | 官方 Resend SDK、模板 ID、幂等和退避重试 |
| `worker/portfolio.ts` | 强制用户归属的个人数据访问 |
| `worker/calculations.ts`、`render.ts`、`validation.ts` | 复用股息计算和输入校验 |
| `worker/providers.ts`、`bollinger.ts` | 公开行情和各周期 BOLL |
| `migrations/0002_accounts.sql` | 独立用户数据表，不覆盖旧单人表 |
| `scripts/local-server.mjs`、`local-d1.mjs` | 可移植本地 HTTP 与数据库适配 |
| `.local/accounts/` | 新的本地账号 SQLite，忽略提交 |
| `backend/`、`worker/legacy.ts` | 保留的 Flask / 单人 D1 历史实现 |

## 数据保留

`backend/data/` 的原 SQLite、备份和 seed，以及 `.wrangler/state/` 旧 D1 均保留，当前启动器不读写。新账号初始为空，不自动认领旧数据。测试使用独立临时数据库，不清空或重建个人数据库。

私人 seed、SQLite、SQL/JSON 备份、邮件收信记录、密钥和账号配置不能放入 `public/` 或 `out/`。网站不会执行根目录 Excel 更新脚本。

详见[账号安全与隔离](accounts.md)、[Resend 配置](resend-setup.md)和[计算口径](calculations.md)。Node/SQLite 测试验证业务行为；Cloudflare 原生运行时与生产服务另做验证，结果记录在部署文档。

账号版的全局刷新与 `POST /api/stocks/:id/refresh` 共用 `worker/refresh.ts`：查询报价、年度/滚动股息及汇率，按账号和证券身份保存分红快照（含财年、明细和来源）。上游查询并行有界，单项失败不清空旧值；提交时比较原始文档，并保留查询期间的手动修改。只有成功写入的记录能推进刷新时间和行情日期。历史分位由后台自动流程通过 `POST /api/stocks/:id/history` 独立获取；不会用当前股息填造历史样本。

`worker/history.ts` 使用真实不复权历史日线，按公告后下一交易日生效的已披露完整年度股息计算，排除当日未完成日线。前端登录加载股票列表后自动补齐各股票历史（同时处理两支），同日成功快照复用并持久化。失败展示来源原因并保留旧快照；当前股息或证券身份变化会清除对应历史及缓存标记。分位和逆分位统一沿用至少 60 个样本的经验分布。来源响应有大小和时间限制，历史查询按年分段、有界并发。
